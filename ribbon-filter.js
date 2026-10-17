/*
 * ribbon/ribbon-filter.js
 *
 * A small, readable Ribbon filter (plus a Bloom filter for comparison).
 * Works in the browser and in Node (for testing).
 *
 * THE IDEA IN PLAIN WORDS
 * A Ribbon filter answers one question: "is this key in my set?"
 *   - "No"    -> the key is DEFINITELY not in the set.
 *   - "Maybe" -> the key is probably in the set (small chance of a false alarm).
 * It never says "No" for a key that really is in the set.
 *
 * HOW IT WORKS
 * Every key is hashed into three things:
 *   1. a start slot        (where its "ribbon" begins)
 *   2. a 32-bit pattern    (which of the next 32 slots it uses)
 *   3. a fingerprint       (r bits, e.g. 8)
 * Each key becomes one equation:
 *      XOR of the slots picked by the pattern  =  fingerprint
 * We solve all equations at once (Gaussian elimination over XOR). Because each
 * equation only touches 32 neighbouring slots, the equations form a thin
 * diagonal band (a "ribbon"), so solving is fast. We then store only the
 * solved slots and throw the keys away.
 *
 * LOOKUP
 * Hash the key again, XOR the same slots, compare with the fingerprint.
 * For a stored key the answer always matches. For any other key the answer
 * matches only by luck, with probability about 1 / 2^r.
 */
(function (root) {
  "use strict";

  const W = 32; // ribbon width: number of slots one key can touch
  const encoder = new TextEncoder();

  /* ---------- hashing (MurmurHash3, 32-bit) ---------- */
  function murmur3(bytes, seed) {
    let h = seed >>> 0;
    const len = bytes.length;
    const blocks = len >> 2;
    for (let i = 0; i < blocks; i++) {
      let k =
        bytes[4 * i] |
        (bytes[4 * i + 1] << 8) |
        (bytes[4 * i + 2] << 16) |
        (bytes[4 * i + 3] << 24);
      k = Math.imul(k, 0xcc9e2d51);
      k = (k << 15) | (k >>> 17);
      k = Math.imul(k, 0x1b873593);
      h ^= k;
      h = (h << 13) | (h >>> 19);
      h = (Math.imul(h, 5) + 0xe6546b64) | 0;
    }
    let k = 0;
    const tail = blocks << 2;
    switch (len & 3) {
      case 3:
        k ^= bytes[tail + 2] << 16; // falls through
      case 2:
        k ^= bytes[tail + 1] << 8; // falls through
      case 1:
        k ^= bytes[tail];
        k = Math.imul(k, 0xcc9e2d51);
        k = (k << 15) | (k >>> 17);
        k = Math.imul(k, 0x1b873593);
        h ^= k;
    }
    h ^= len;
    h ^= h >>> 16;
    h = Math.imul(h, 0x85ebca6b);
    h ^= h >>> 13;
    h = Math.imul(h, 0xc2b2ae35);
    h ^= h >>> 16;
    return h >>> 0;
  }

  // index of the lowest set bit of a 32-bit number
  function ctz32(x) {
    return 31 - Math.clz32((x & -x) >>> 0);
  }

  // Turn a key into: start slot, 32-bit pattern, fingerprint
  function hashKey(bytes, seed, m, fpMask) {
    const s = Math.imul(seed, 0x9e3779b1) >>> 0;
    const h1 = murmur3(bytes, s ^ 0x1b873593);
    const h2 = murmur3(bytes, s ^ 0x85ebca6b);
    const h3 = murmur3(bytes, s ^ 0xc2b2ae35);
    const range = m - W + 1; // valid start slots: 0 .. m - W
    return {
      start: Math.floor((h1 / 4294967296) * range),
      coeff: (h2 | 1) >>> 0, // bit 0 always set: the key always uses its start slot
      fp: h3 & fpMask,
    };
  }

  /* ---------- construction ---------- */
  // Returns the solved slots, or null if this seed/size has no solution.
  function tryBuild(encodedKeys, m, seed, fpBits) {
    const fpMask = (1 << fpBits) - 1;
    const rowCoeff = new Uint32Array(m); // pattern stored for each pivot slot
    const rowValue = new Uint16Array(m); // fingerprint stored for each pivot slot

    for (const bytes of encodedKeys) {
      const hk = hashKey(bytes, seed, m, fpMask);
      let i = hk.start;
      let c = hk.coeff;
      let b = hk.fp;
      for (;;) {
        const existing = rowCoeff[i];
        if (existing === 0) {
          rowCoeff[i] = c;
          rowValue[i] = b;
          break;
        }
        // eliminate the pivot bit using the equation already stored here
        c = (c ^ existing) >>> 0;
        b ^= rowValue[i];
        if (c === 0) {
          if (b !== 0) return null; // contradiction: need another seed or more slots
          break; // redundant equation, already satisfied
        }
        const shift = ctz32(c);
        c >>>= shift;
        i += shift;
      }
    }

    // back-substitution: solve from the last slot to the first
    const z = fpBits <= 8 ? new Uint8Array(m) : new Uint16Array(m);
    for (let i = m - 1; i >= 0; i--) {
      const c = rowCoeff[i];
      if (c === 0) continue; // free slot: leave at 0
      let acc = rowValue[i];
      let rest = c >>> 1;
      let j = 1;
      while (rest) {
        if (rest & 1) acc ^= z[i + j];
        rest >>>= 1;
        j++;
      }
      z[i] = acc;
    }
    return z;
  }

  class RibbonFilter {
    constructor(z, m, seed, fpBits, n, attempts) {
      this.z = z; // the solved slots (this is the whole filter)
      this.m = m; // number of slots
      this.seed = seed;
      this.fpBits = fpBits;
      this.fpMask = (1 << fpBits) - 1;
      this.n = n; // number of keys stored
      this.attempts = attempts; // how many seeds/sizes were tried before success
      this.width = W;
    }

    static build(keys, options) {
      const opts = options || {};
      const fpBits = opts.fpBits || 8;
      if (fpBits < 1 || fpBits > 16) throw new Error("fpBits must be between 1 and 16");
      let overhead = opts.overhead || 1.1; // slots per key; grows if building fails
      const unique = Array.from(new Set(keys));
      const encoded = unique.map((k) => encoder.encode(k));
      let attempts = 0;
      for (let round = 0; round < 40; round++) {
        const m = Math.max(W + 1, Math.ceil(unique.length * overhead));
        for (let seed = 1; seed <= 25; seed++) {
          attempts++;
          const z = tryBuild(encoded, m, seed, fpBits);
          if (z) return new RibbonFilter(z, m, seed, fpBits, unique.length, attempts);
        }
        overhead += 0.05;
      }
      throw new Error("Could not build the Ribbon filter");
    }

    // Fast yes/maybe answer
    has(key) {
      const hk = hashKey(encoder.encode(key), this.seed, this.m, this.fpMask);
      let acc = 0;
      let rest = hk.coeff;
      let j = 0;
      while (rest) {
        if (rest & 1) acc ^= this.z[hk.start + j];
        rest >>>= 1;
        j++;
      }
      return acc === hk.fp;
    }

    // Same lookup, but returns every step so the dashboard can show it
    explain(key) {
      const hk = hashKey(encoder.encode(key), this.seed, this.m, this.fpMask);
      const slots = [];
      const bits = [];
      let acc = 0;
      for (let j = 0; j < W; j++) {
        const used = (hk.coeff >>> j) & 1;
        bits.push(used);
        if (used) {
          const index = hk.start + j;
          const value = this.z[index];
          slots.push({ offset: j, index: index, value: value });
          acc ^= value;
        }
      }
      return {
        key: key,
        start: hk.start,
        end: hk.start + W - 1,
        bits: bits, // 32 entries: 1 = this offset is used
        slots: slots, // the slots that were read
        fingerprint: hk.fp,
        xor: acc,
        match: acc === hk.fp,
      };
    }

    get sizeBits() {
      return this.m * this.fpBits;
    }
    get sizeBytes() {
      return Math.ceil(this.sizeBits / 8);
    }
    get bitsPerKey() {
      return this.n ? this.sizeBits / this.n : 0;
    }
    get expectedFalsePositiveRate() {
      return 1 / Math.pow(2, this.fpBits);
    }
  }

  /* ---------- Bloom filter (for the size comparison) ---------- */
  class BloomFilter {
    constructor(bits, hashCount) {
      this.m = bits;
      this.k = hashCount;
      this.bytes = new Uint8Array(Math.ceil(bits / 8));
      this.n = 0;
    }

    static forFalsePositiveRate(n, p) {
      const count = Math.max(1, n);
      const m = Math.ceil((-count * Math.log(p)) / (Math.LN2 * Math.LN2));
      const k = Math.max(1, Math.round((m / count) * Math.LN2));
      return new BloomFilter(m, k);
    }

    _positions(key) {
      const bytes = encoder.encode(key);
      const h1 = murmur3(bytes, 0x1234abcd);
      const h2 = murmur3(bytes, 0x9876fedc) | 1;
      const out = [];
      for (let i = 0; i < this.k; i++) {
        out.push(((h1 + Math.imul(i, h2)) >>> 0) % this.m);
      }
      return out;
    }

    add(key) {
      for (const p of this._positions(key)) this.bytes[p >> 3] |= 1 << (p & 7);
      this.n++;
    }

    has(key) {
      for (const p of this._positions(key)) {
        if (!(this.bytes[p >> 3] & (1 << (p & 7)))) return false;
      }
      return true;
    }

    get sizeBits() {
      return this.m;
    }
    get sizeBytes() {
      return Math.ceil(this.m / 8);
    }
    get bitsPerKey() {
      return this.n ? this.m / this.n : this.m;
    }
  }

  const api = { RibbonFilter: RibbonFilter, BloomFilter: BloomFilter, murmur3: murmur3 };
  root.RibbonFilter = RibbonFilter;
  root.BloomFilter = BloomFilter;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);
