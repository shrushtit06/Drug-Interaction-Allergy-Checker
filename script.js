/*
 * script.js
 * Drives the dashboard: input handling, the step-by-step process view,
 * results, and the interactive Ribbon filter lab.
 *
 * Needs ribbon/ribbon-filter.js (loaded first) and data/interactions.json.
 * Open the folder through a local server, for example:
 *     python -m http.server 8000      then visit http://localhost:8000
 */
(() => {
  "use strict";

  /* ================= Settings ================= */
  const DATA_URL = "data/interactions.json";
  const FP_BITS = 8; // fingerprint size of the filter used by the checker

  // OPTIONAL AI explanations. Leave empty to turn the AI button off.
  // Point this at your own small backend that calls an LLM. Never put an API
  // key in this file: anyone who opens the page could read it.
  // Expected: POST { drugA, drugB, severity, description } -> { explanation }
  const AI_CONFIG = { endpoint: "" };

  // Penicillin allergy: cephalosporins sometimes cross-react, so we warn.
  const CROSS_REACTIVE = { penicillin: ["cephalosporin"] };

  const SEVERITY_ORDER = { major: 0, moderate: 1, minor: 2 };
  const SEVERITY_LABEL = { major: "Major", moderate: "Moderate", minor: "Minor" };
  const ADVICE = {
    major: "Avoid taking these together unless your doctor has told you to. Ask about a safer alternative.",
    moderate: "Sometimes used together with a dose change or closer monitoring. Check with your doctor or pharmacist.",
    minor: "Usually low concern. Mention it to your pharmacist at your next visit.",
  };
  const GROUP_LABEL = {
    penicillin: "Penicillins",
    cephalosporin: "Cephalosporins",
    sulfonamide: "Sulfa drugs",
    nsaid: "NSAID painkillers",
    opioid: "Opioids",
    macrolide: "Macrolides",
    fluoroquinolone: "Fluoroquinolones",
    tetracycline: "Tetracyclines",
    "aromatic anticonvulsant": "Aromatic anticonvulsants",
    allopurinol: "Allopurinol",
  };

  const MEANING = {
    danger: "At least one pair is a major interaction, or a medicine matches an allergy you selected. Raise these first with your doctor or pharmacist.",
    caution: "Nothing here is flagged as major, but some combinations need monitoring or a quick check before you take them together.",
    ok: "No pair matched. That only covers the interactions in this small dataset, so it does not prove the combination is safe.",
  };

  const STAGES = [
    { id: "input", title: "Read your input" },
    { id: "pairs", title: "Build medicine pairs", waiting: "Runs when you press Check. Every medicine is paired with every other one." },
    { id: "ribbon", title: "Ask the Ribbon filter", waiting: "Runs when you press Check. For each pair the filter answers \u201Cdefinitely not\u201D or \u201Cmaybe\u201D." },
    { id: "confirm", title: "Confirm in the table", waiting: "Only the \u201Cmaybe\u201D pairs get looked up in the full table." },
    { id: "allergy", title: "Check allergies", waiting: "Compares each medicine's group with the allergies you selected." },
    { id: "report", title: "Prepare the report", waiting: "Collects everything into the results below." },
  ];
  const STATE_LABEL = { live: "Updates as you type", waiting: "Waiting", running: "Working", done: "Done" };

  const reduceMotion =
    typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  /* ================= Small helpers ================= */
  const $ = (id) => document.getElementById(id);

  function h(tag, props, ...children) {
    const node = document.createElement(tag);
    if (props) {
      for (const [k, v] of Object.entries(props)) {
        if (v == null || v === false) continue;
        if (k === "class") node.className = v;
        else if (k.startsWith("on")) node.addEventListener(k.slice(2).toLowerCase(), v);
        else node.setAttribute(k, v === true ? "" : v);
      }
    }
    for (const c of children.flat(Infinity)) {
      if (c == null || c === false) continue;
      node.append(c instanceof Node ? c : document.createTextNode(String(c)));
    }
    return node;
  }

  const cap = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);
  const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
  const toBits = (v, n) => v.toString(2).padStart(n, "0");
  const hex = (v, bits) => v.toString(16).padStart(Math.ceil(bits / 4), "0");
  const pct = (x) => (x * 100).toFixed(x * 100 < 1 ? 2 : 1) + "%";
  const groupLabel = (g) => GROUP_LABEL[g] || cap(g);
  const pairKey = (a, b) => [a, b].sort().join("+");

  /* ================= State ================= */
  const state = {
    drugs: [], // { raw, normalized, generic, viaBrand, known }
    allergies: new Set(),
    session: { checks: 0, pairs: 0, skipped: 0, maybe: 0, confirmed: 0, falseAlarms: 0 },
  };
  let db = null;
  let runToken = 0;
  let skipAnimation = false;
  let hasRun = false;
  let falseAlarmCursor = 0;
  let buildStep = 0;

  const el = {
    loadError: $("load-error"),
    form: $("add-form"),
    input: $("drug-input"),
    addBtn: $("add-btn"),
    datalist: $("drug-list"),
    hint: $("input-hint"),
    chips: $("drug-chips"),
    allergyChips: $("allergy-chips"),
    allergyCovers: $("allergy-covers"),
    checkBtn: $("check-btn"),
    exampleBtn: $("example-btn"),
    clearBtn: $("clear-btn"),
    skipBtn: $("skip-btn"),
    process: $("process"),
    results: $("results"),
    tabChecker: $("tab-checker"),
    tabLab: $("tab-lab"),
    viewChecker: $("view-checker"),
    viewLab: $("view-lab"),
    labForm: $("lab-form"),
    labA: $("lab-a"),
    labB: $("lab-b"),
    labGo: $("lab-go"),
    labQuick: $("lab-quick"),
    labHint: $("lab-hint"),
    labOutput: $("lab-output"),
    buildSteps: $("build-steps"),
    buildBody: $("build-body"),
    bitsRange: $("bits-range"),
    bitsOut: $("bits-out"),
    tuneOutput: $("tune-output"),
    sessionStats: $("session-stats"),
    sideSession: $("side-session"),
    pipeSteps: $("pipe-steps"),
    pipeBody: $("pipe-body"),
    tuneChart: $("tune-chart"),
  };

  /* ================= Names ================= */
  function normalize(raw) {
    return raw
      .toLowerCase()
      .replace(/\b\d+(?:\.\d+)?\s*(?:mg|mcg|g|ml|iu)?\b/g, " ")
      .replace(/\b(?:tablets?|tabs?|capsules?|caps?|syrup|injection)\b/g, " ")
      .replace(/[^a-z\s-]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function resolveDrug(raw) {
    const normalized = normalize(raw);
    if (!normalized) return null;
    const viaBrand = db.brands.has(normalized);
    const generic = viaBrand ? db.brands.get(normalized) : normalized;
    return { raw: raw.trim(), normalized, generic, viaBrand, known: db.knownDrugs.has(generic) };
  }

  /* ================= Database + filters ================= */
  function makeBloom(keys, bits) {
    const bloom = BloomFilter.forFalsePositiveRate(keys.length, Math.pow(2, -bits));
    keys.forEach((k) => bloom.add(k));
    return bloom;
  }

  function buildDatabase(data) {
    const table = new Map();
    const keys = [];
    const interactionDrugs = new Set();
    for (const r of data.interactions) {
      const key = pairKey(r.a, r.b);
      table.set(key, r);
      keys.push(key);
      interactionDrugs.add(r.a);
      interactionDrugs.add(r.b);
    }
    const ribbon = RibbonFilter.build(keys, { fpBits: FP_BITS });

    const drugToGroup = new Map();
    const groups = new Map();
    for (const a of data.allergies) {
      drugToGroup.set(a.drug, a.group);
      if (!groups.has(a.group)) groups.set(a.group, []);
      groups.get(a.group).push(a.drug);
    }
    const brands = new Map(Object.entries(data.brands));
    const knownDrugs = new Set([...interactionDrugs, ...drugToGroup.keys()]);
    const drugList = [...interactionDrugs].sort();

    // Every pair of listed medicines that is NOT an interaction. Used to
    // measure false alarms honestly.
    const negativeKeys = [];
    for (let i = 0; i < drugList.length; i++) {
      for (let j = i + 1; j < drugList.length; j++) {
        const key = pairKey(drugList[i], drugList[j]);
        if (!table.has(key)) negativeKeys.push(key);
      }
    }
    const falseAlarmKeys = negativeKeys.filter((k) => ribbon.has(k));
    const missed = keys.filter((k) => !ribbon.has(k)).length;

    return { table, keys, ribbon, drugToGroup, groups, brands, knownDrugs, drugList, negativeKeys, falseAlarmKeys, missed, meta: data.meta || {} };
  }

  /* ================= Input: medicines ================= */
  function setHint(text, isError) {
    el.hint.textContent = text || "";
    el.hint.classList.toggle("hint--error", !!isError);
  }

  function addDrug(raw) {
    const drug = resolveDrug(raw);
    if (!drug) {
      setHint("Type a medicine name first.", true);
      return false;
    }
    if (state.drugs.some((d) => d.generic === drug.generic)) {
      setHint(`${cap(drug.generic)} is already in your list.`, true);
      return false;
    }
    state.drugs.push(drug);
    if (drug.viaBrand) setHint(`${cap(drug.raw)} is a brand name. Using ${drug.generic}.`);
    else if (!drug.known) setHint(`${cap(drug.generic)} is not in this small dataset, so it can't be checked.`, true);
    else setHint("");
    onInputChanged();
    return true;
  }

  function removeDrug(generic) {
    state.drugs = state.drugs.filter((d) => d.generic !== generic);
    onInputChanged();
  }

  function renderChips() {
    el.chips.replaceChildren(
      ...state.drugs.map((d) =>
        h(
          "li",
          { class: "chip" + (d.known ? "" : " chip--unknown") },
          h("span", { class: "chip__pill", "aria-hidden": "true" }),
          cap(d.generic),
          d.viaBrand ? h("span", { class: "chip__note" }, `from ${d.raw}`) : null,
          d.known ? null : h("span", { class: "chip__note" }, "no data"),
          h("button", { class: "chip__remove", type: "button", "aria-label": `Remove ${d.generic}`, onClick: () => removeDrug(d.generic) }, "\u00D7")
        )
      )
    );
  }

  /* ================= Input: allergies ================= */
  function renderAllergyToggles() {
    const groups = [...db.groups.keys()].sort((a, b) => groupLabel(a).localeCompare(groupLabel(b)));
    el.allergyChips.replaceChildren(
      ...groups.map((g) =>
        h(
          "button",
          {
            class: "toggle",
            type: "button",
            "aria-pressed": String(state.allergies.has(g)),
            onClick: () => {
              if (state.allergies.has(g)) state.allergies.delete(g);
              else state.allergies.add(g);
              onInputChanged();
            },
          },
          groupLabel(g)
        )
      )
    );
  }

  function renderAllergyCovers() {
    const rows = [...state.allergies]
      .sort()
      .map((g) => h("p", null, h("strong", null, groupLabel(g) + ": "), db.groups.get(g).join(", ")));
    el.allergyCovers.replaceChildren(...rows);
  }

  /* ================= Process stepper ================= */
  const stageEls = {};

  function buildProcessShell() {
    STAGES.forEach((s, i) => {
      const status = h("span", { class: "stage__status" });
      const body = h("div", { class: "stage__body" });
      const li = h(
        "li",
        { class: "stage", id: "stage-" + s.id },
        h("span", { class: "stage__marker", "aria-hidden": "true" }, String(i + 1)),
        h("div", { class: "stage__head" }, h("h3", { class: "stage__title" }, s.title), status),
        body
      );
      stageEls[s.id] = { li, status, body, def: s };
      el.process.append(li);
    });
    resetStages();
    renderInputStage();
  }

  function setStage(id, stateName, content) {
    const s = stageEls[id];
    s.li.dataset.state = stateName;
    s.status.textContent = STATE_LABEL[stateName];
    if (content !== undefined) s.body.replaceChildren(...[].concat(content));
  }

  function resetStages() {
    for (const s of STAGES) {
      if (s.id === "input") continue;
      setStage(s.id, "waiting", h("p", { class: "stage__hint" }, s.waiting));
    }
  }

  function renderInputStage() {
    if (!state.drugs.length && !state.allergies.size) {
      setStage("input", "live", h("p", { class: "stage__hint" }, "Nothing yet. Add a medicine on the left and it shows up here."));
      return;
    }
    const list = h("ul", { class: "mini-list" });
    for (const d of state.drugs) {
      let what;
      if (d.viaBrand) what = [h("strong", null, d.raw), " is a brand name. Using ", h("strong", null, d.generic), "."];
      else if (d.raw.trim().toLowerCase() !== d.generic) what = [h("strong", null, d.raw), " cleaned up to ", h("strong", null, d.generic), "."];
      else if (!d.known) what = [h("strong", null, cap(d.generic)), " was not found in the dataset."];
      else what = [h("strong", null, cap(d.generic)), " recognised."];
      list.append(h("li", null, what, d.known ? h("span", { class: "tag" }, "in dataset") : h("span", { class: "tag tag--warn" }, "no data")));
    }
    for (const g of [...state.allergies].sort()) {
      list.append(h("li", null, "Allergy group selected: ", h("strong", null, groupLabel(g)), ` (covers ${plural(db.groups.get(g).length, "medicine")}).`));
    }
    setStage("input", "live", list);
  }

  function pause(ms) {
    return skipAnimation ? Promise.resolve() : new Promise((r) => setTimeout(r, ms));
  }

  function onInputChanged() {
    runToken++; // stops any animation that is still running
    el.checkBtn.disabled = false;
    el.skipBtn.hidden = true;
    renderChips();
    renderAllergyToggles();
    renderAllergyCovers();
    renderInputStage();
    if (hasRun) {
      resetStages();
      el.results.replaceChildren(emptyResults());
      hasRun = false;
    }
  }

  /* ================= Check ================= */
  function traceRow(info, fpBits) {
    const maybe = info.match;
    const row = h(
      "li",
      { class: "trace-row " + (maybe ? "trace-row--maybe" : "trace-row--no") },
      h("span", { class: "trace-row__key" }, info.key),
      h(
        "span",
        { class: "trace-row__math" },
        h("span", null, "Slots ", h("b", null, `${info.start} to ${info.end}`)),
        h("span", null, "XOR of ", plural(info.slots.length, "slot"), ": ", h("b", null, toBits(info.xor, fpBits))),
        h("span", null, "Fingerprint: ", h("b", null, toBits(info.fingerprint, fpBits)))
      ),
      h(
        "span",
        { class: "trace-row__end" },
        h("span", { class: "verdict " + (maybe ? "verdict--maybe" : "verdict--no") }, maybe ? "Maybe" : "Definitely not"),
        h("button", { class: "link", type: "button", onClick: () => openInLab(info.key) }, "See in lab")
      )
    );
    return row;
  }

  function keyChips(pairs) {
    const shown = pairs.slice(0, 14);
    const list = h("ul", { class: "keys" }, shown.map((p) => h("li", null, p.key)));
    if (pairs.length > shown.length) list.append(h("li", null, `+ ${pairs.length - shown.length} more`));
    return list;
  }

  async function runCheck() {
    if (!db) return;
    if (!state.drugs.length) {
      setHint("Add at least one medicine first.", true);
      el.input.focus();
      return;
    }
    const token = ++runToken;
    const alive = () => token === runToken;
    skipAnimation = reduceMotion;
    hasRun = true;
    el.checkBtn.disabled = true;
    el.skipBtn.hidden = reduceMotion;
    resetStages();
    el.results.replaceChildren(h("p", { class: "empty" }, "Working on it. The steps above show what is happening."));

    const generics = [...new Set(state.drugs.map((d) => d.generic))];
    const fpBits = db.ribbon.fpBits;
    const trace = { pairs: 0, skipped: 0, maybe: 0, confirmed: 0, falseAlarms: 0 };

    /* Step 2: pairs */
    setStage("pairs", "running");
    await pause(450);
    if (!alive()) return;
    const pairs = [];
    for (let i = 0; i < generics.length; i++) {
      for (let j = i + 1; j < generics.length; j++) pairs.push({ a: generics[i], b: generics[j], key: pairKey(generics[i], generics[j]) });
    }
    trace.pairs = pairs.length;
    if (pairs.length) {
      setStage("pairs", "done", [
        h("p", null, `${plural(generics.length, "medicine")} make ${plural(pairs.length, "pair")}. Each pair becomes one key, with the names sorted so the order never matters.`),
        keyChips(pairs),
      ]);
    } else {
      setStage("pairs", "done", h("p", null, "With one medicine there are no pairs to check. Add a second medicine to look for interactions."));
    }
    await pause(350);
    if (!alive()) return;

    /* Step 3: Ribbon filter */
    const lookups = [];
    if (pairs.length) {
      const list = h("ul", { class: "trace-list" });
      setStage("ribbon", "running", [
        h("p", null, "For each key the filter hashes it, reads a handful of slots, XORs them and compares the result with the key's fingerprint."),
        list,
      ]);
      const delay = pairs.length > 12 ? 70 : 380;
      for (const p of pairs) {
        await pause(delay);
        if (!alive()) return;
        const info = db.ribbon.explain(p.key);
        lookups.push({ ...p, info });
        list.append(traceRow(info, fpBits));
        list.scrollTop = list.scrollHeight;
      }
      trace.maybe = lookups.filter((l) => l.info.match).length;
      trace.skipped = pairs.length - trace.maybe;
      setStage("ribbon", "done", [
        h("p", null, "For each key the filter hashes it, reads a handful of slots, XORs them and compares the result with the key's fingerprint."),
        list,
        h("p", null, `${plural(trace.skipped, "pair")} got \u201Cdefinitely not\u201D. ${plural(trace.maybe, "pair")} got \u201Cmaybe\u201D.`),
      ]);
    } else {
      setStage("ribbon", "done", h("p", { class: "stage__hint" }, "Nothing to look up."));
    }
    await pause(350);
    if (!alive()) return;

    /* Step 4: table lookup for the "maybe" pairs */
    const found = [];
    if (pairs.length) {
      const maybes = lookups.filter((l) => l.info.match);
      setStage("confirm", "running");
      await pause(300);
      if (!alive()) return;
      const list = h("ul", { class: "mini-list" });
      for (const l of maybes) {
        const rec = db.table.get(l.key);
        if (rec) {
          trace.confirmed++;
          found.push(rec);
          list.append(h("li", null, h("strong", null, l.key), ": found in the table, ", h("span", { class: "verdict verdict--real" }, SEVERITY_LABEL[rec.severity] + " interaction")));
        } else {
          trace.falseAlarms++;
          list.append(h("li", null, h("strong", null, l.key), ": not in the table. The filter gave a false alarm and the lookup caught it."));
        }
        setStage("confirm", "running", [list]);
        await pause(maybes.length > 12 ? 60 : 320);
        if (!alive()) return;
      }
      const skippedNote = h("p", null, `${plural(trace.skipped, "table lookup")} skipped, because the filter had already said \u201Cdefinitely not\u201D.`);
      setStage("confirm", "done", [maybes.length ? list : h("p", null, "No \u201Cmaybe\u201D pairs, so the table was not needed at all."), skippedNote]);
    } else {
      setStage("confirm", "done", h("p", { class: "stage__hint" }, "Nothing to confirm."));
    }
    await pause(350);
    if (!alive()) return;

    /* Step 5: allergies */
    setStage("allergy", "running");
    await pause(350);
    if (!alive()) return;
    const alerts = computeAllergyAlerts(generics);
    if (!state.allergies.size) {
      setStage("allergy", "done", h("p", { class: "stage__hint" }, "No allergies selected, so there is nothing to compare."));
    } else {
      const list = h("ul", { class: "mini-list" });
      for (const d of generics) {
        const g = db.drugToGroup.get(d);
        if (!g) {
          list.append(h("li", null, h("strong", null, cap(d)), " is not in an allergy group this dataset tracks."));
          continue;
        }
        const hit = alerts.find((a) => a.drug === d);
        list.append(
          h("li", null, h("strong", null, cap(d)), ` belongs to the ${groupLabel(g).toLowerCase()} group. `,
            hit ? h("span", { class: "verdict " + (hit.type === "direct" ? "verdict--real" : "verdict--maybe") }, hit.type === "direct" ? "Matches your allergy" : "Possible cross-reaction") : h("span", { class: "tag" }, "No match"))
        );
      }
      setStage("allergy", "done", list);
    }
    await pause(350);
    if (!alive()) return;

    /* Step 6: report */
    setStage("report", "running");
    await pause(300);
    if (!alive()) return;
    found.sort((x, y) => SEVERITY_ORDER[x.severity] - SEVERITY_ORDER[y.severity] || x.a.localeCompare(y.a));
    renderResults({ generics, found, alerts, trace });
    setStage("report", "done", h("p", null, `Found ${plural(found.length, "interaction")} and ${plural(alerts.length, "allergy alert")}. The full report is in Results.`));

    const s = state.session;
    s.checks++;
    s.pairs += trace.pairs;
    s.skipped += trace.skipped;
    s.maybe += trace.maybe;
    s.confirmed += trace.confirmed;
    s.falseAlarms += trace.falseAlarms;
    renderSessionStats();

    el.checkBtn.disabled = false;
    el.skipBtn.hidden = true;
  }

  function computeAllergyAlerts(generics) {
    const alerts = [];
    for (const d of generics) {
      const group = db.drugToGroup.get(d);
      if (!group) continue;
      if (state.allergies.has(group)) {
        alerts.push({ type: "direct", drug: d, group });
        continue;
      }
      for (const allergy of state.allergies) {
        if ((CROSS_REACTIVE[allergy] || []).includes(group)) alerts.push({ type: "cross", drug: d, group, allergy });
      }
    }
    return alerts;
  }

  /* ================= Results ================= */
  function emptyResults() {
    const outcome = (cls, title, text) => h("div", { class: "outcome outcome--" + cls }, h("h4", null, title), h("p", null, text));
    return h("div", { class: "guide" },
      h("p", { class: "empty" }, "Results appear here after you press Check my medicines. Add at least two medicines to look for interactions. This is what you might see:"),
      h("div", { class: "outcomes" },
        outcome("danger", "Serious issues found", "A major interaction, or a medicine that matches an allergy you selected. Avoid the combination unless your doctor says otherwise."),
        outcome("caution", "Some combinations need a check", "Moderate or minor interactions, or a possible allergy cross-reaction. Often fine with monitoring or a dose change. Ask a pharmacist."),
        outcome("ok", "No known interactions in this dataset", "Nothing matched. The dataset is small, so this is not proof that the combination is safe.")),
      h("p", { class: "note" }, "You will also get charts of how the filter handled your pairs and how serious the matches are, plus a short explanation of each card."));
  }

  async function getAIExplanation(rec) {
    if (!AI_CONFIG.endpoint) return null;
    try {
      const res = await fetch(AI_CONFIG.endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ drugA: rec.a, drugB: rec.b, severity: rec.severity, description: rec.description }),
      });
      if (!res.ok) return null;
      const data = await res.json();
      return data.explanation || null;
    } catch (err) {
      return null;
    }
  }

  function interactionCard(rec) {
    const sev = rec.severity;
    const card = h(
      "article",
      { class: "card card--" + sev },
      h("header", { class: "card__head" },
        h("div", { class: "pairing" }, h("span", { class: "pill" }, cap(rec.a)), h("span", { class: "pairing__plus", "aria-hidden": "true" }, "+"), h("span", { class: "pill" }, cap(rec.b))),
        h("span", { class: "badge badge--" + sev }, SEVERITY_LABEL[sev])),
      h("p", { class: "card__what" }, rec.description),
      h("p", { class: "card__advice" }, ADVICE[sev]),
      h("p", { class: "card__trace" }, "Ribbon filter said maybe. The table lookup confirmed this pair.")
    );
    if (AI_CONFIG.endpoint) {
      const out = h("p", { class: "card__ai", hidden: true });
      const btn = h("button", { class: "btn btn--secondary", type: "button" }, "Explain with AI");
      btn.addEventListener("click", async () => {
        btn.disabled = true;
        btn.textContent = "Asking the AI...";
        const text = await getAIExplanation(rec);
        out.hidden = false;
        if (text) {
          out.textContent = text;
          btn.remove();
        } else {
          out.textContent = "Could not reach the AI service. Try again in a moment.";
          btn.disabled = false;
          btn.textContent = "Explain with AI";
        }
      });
      card.append(btn, out);
    }
    return card;
  }

  function alertCard(a) {
    const direct = a.type === "direct";
    return h(
      "article",
      { class: "card " + (direct ? "card--allergy" : "card--caution") },
      h("header", { class: "card__head" },
        h("div", { class: "pairing" }, h("span", { class: "pill" }, cap(a.drug))),
        h("span", { class: "badge " + (direct ? "badge--allergy" : "badge--caution") }, direct ? "Allergy alert" : "Caution")),
      h("p", { class: "card__what" },
        direct
          ? `${cap(a.drug)} is in the ${groupLabel(a.group).toLowerCase()} group, and you marked ${groupLabel(a.group).toLowerCase()} as an allergy.`
          : `${cap(a.drug)} is in the ${groupLabel(a.group).toLowerCase()} group. You marked ${groupLabel(a.allergy).toLowerCase()} as an allergy, and people with that allergy sometimes react to this group too.`),
      h("p", { class: "card__advice" }, direct ? "Do not take it unless your doctor confirms it is safe for you." : "Ask your doctor or pharmacist before taking it.")
    );
  }

  function renderResults({ generics, found, alerts, trace }) {
    const majors = found.filter((f) => f.severity === "major").length;
    const direct = alerts.filter((a) => a.type === "direct").length;
    let tone = "ok";
    let headline = "No known interactions in this dataset";
    let detail = `This checked ${plural(trace.pairs, "pair")} against ${db.keys.length} listed interactions. A clear result here does not prove a combination is safe.`;
    if (majors || direct) {
      tone = "danger";
      headline = "Serious issues found";
    } else if (found.length || alerts.length) {
      tone = "caution";
      headline = "Some combinations need a check";
    }
    if (tone !== "ok") {
      const parts = [];
      if (majors) parts.push(plural(majors, "major interaction"));
      if (found.length - majors) parts.push(plural(found.length - majors, "other interaction"));
      if (direct) parts.push(plural(direct, "allergy alert"));
      if (alerts.length - direct) parts.push(plural(alerts.length - direct, "cross-reaction caution"));
      detail = `${parts.join(", ")}. Talk to your doctor or pharmacist before taking these together.`;
    }
    if (generics.length < 2 && tone === "ok") detail = "Add a second medicine to check for interactions. Allergies were still checked.";

    const nodes = [
      h("div", { class: "banner banner--" + tone },
        h("h3", null, headline),
        h("p", null, detail),
        h("p", { class: "banner__trace" }, `Filter trace: ${plural(trace.pairs, "pair")} checked, ${trace.maybe} maybe, ${trace.confirmed} confirmed, ${plural(trace.falseAlarms, "false alarm")} caught, ${plural(trace.skipped, "table lookup")} skipped.`)),
    ];
    const cards = h("div", { class: "cards" }, alerts.map(alertCard), found.map(interactionCard));
    const sevCount = (k) => found.filter((f) => f.severity === k).length;
    nodes.push(h("div", { class: "viz-block" },
      h("h3", null, "How the filter handled your pairs"),
      trace.pairs ? stackBar([{ label: "ruled out by the filter", value: trace.skipped, cls: "no" }, { label: "false alarms caught by the table", value: trace.falseAlarms, cls: "mod" }, { label: "confirmed interactions", value: trace.confirmed, cls: "major" }]) : h("p", { class: "note" }, "No pairs to chart yet."),
      trace.pairs ? h("p", { class: "note" }, `${trace.skipped} of ${trace.pairs} pairs never needed the table. Only the ${plural(trace.maybe, "maybe")} were looked up.`) : null,
      found.length ? [h("h3", null, "How serious the matches are"), stackBar([{ label: "major", value: sevCount("major"), cls: "major" }, { label: "moderate", value: sevCount("moderate"), cls: "mod" }, { label: "minor", value: sevCount("minor"), cls: "no" }])] : null));
    if (cards.children.length) nodes.push(cards);
    nodes.push(h("details", { class: "explain" }, h("summary", null, "What does this result mean?"), h("p", null, MEANING[tone]),
      h("p", null, "Major means the combination can cause serious harm and is usually avoided. Moderate usually needs monitoring or a dose change. Minor is low concern. An allergy alert means a medicine is in a group you marked. A caution means that group sometimes cross-reacts.")));

    const unknown = state.drugs.filter((d) => !d.known);
    if (unknown.length) {
      nodes.push(h("p", { class: "note" }, `No data for ${unknown.map((d) => cap(d.generic)).join(", ")}. That does not mean ${unknown.length === 1 ? "it is" : "they are"} safe to combine. Ask your pharmacist.`));
    }
    nodes.push(h("p", { class: "note" }, "Informational only, not medical advice."));
    el.results.replaceChildren(...nodes);
  }

  /* ================= Tabs ================= */
  function showTab(name) {
    const lab = name === "lab";
    el.tabChecker.setAttribute("aria-selected", String(!lab));
    el.tabLab.setAttribute("aria-selected", String(lab));
    el.tabChecker.tabIndex = lab ? -1 : 0;
    el.tabLab.tabIndex = lab ? 0 : -1;
    el.viewChecker.hidden = lab;
    el.viewLab.hidden = !lab;
  }

  function openInLab(key) {
    const [a, b] = key.split("+");
    showTab("lab");
    el.labA.value = a;
    el.labB.value = b;
    runLabLookup();
    if (typeof el.viewLab.scrollIntoView === "function") el.viewLab.scrollIntoView({ behavior: reduceMotion ? "auto" : "smooth", block: "start" });
  }

  /* ================= Lab: lookup ================= */
  function bitsRow(info) {
    return h("div", { class: "bits", role: "img", "aria-label": `32-bit pattern. Ones at offsets ${info.slots.map((s) => s.offset).join(", ")}` },
      info.bits.map((b) => h("span", { class: "bit" + (b ? " bit--on" : "") }, String(b))));
  }

  function slotGrid(info) {
    const picked = new Map(info.slots.map((s) => [s.index, true]));
    const bits = db.ribbon.fpBits;
    const tiles = [];
    for (let i = 0; i < db.ribbon.m; i++) {
      const inWindow = i >= info.start && i <= info.end;
      tiles.push(h("span", { class: "slot" + (picked.has(i) ? " slot--picked" : inWindow ? " slot--window" : ""), title: `Slot ${i}: ${toBits(db.ribbon.z[i], bits)}` }, hex(db.ribbon.z[i], bits)));
    }
    return [
      h("div", { class: "grid-wrap" }, h("div", { class: "slots", role: "img", "aria-label": `${db.ribbon.m} filter slots. ${info.slots.length} are read for this key.` }, tiles)),
      h("div", { class: "legend" }, h("span", { class: "legend__picked" }, "Slot read for this key"), h("span", { class: "legend__window" }, `Inside the ${db.ribbon.width}-slot window, not read`), h("span", null, "Other slots (values in hex)")),
    ];
  }

  function labStep(title, content) {
    return h("li", { class: "lab-step" }, h("h3", null, title), content);
  }

  function renderLabOutput(a, b) {
    const key = pairKey(a.generic, b.generic);
    const info = db.ribbon.explain(key);
    const rec = info.match ? db.table.get(key) : null;
    const bits = db.ribbon.fpBits;

    let answer;
    if (!info.match) {
      answer = h("div", { class: "answer-box answer-box--no" }, h("h4", null, "Definitely not in the set"),
        h("p", null, "The XOR result and the fingerprint differ, so this pair is not an interaction on the list. The app stops here and never touches the table."));
    } else if (rec) {
      answer = h("div", { class: "answer-box answer-box--real" }, h("h4", null, "Maybe in the set, and the table confirms it"),
        h("p", null, `Table lookup: ${SEVERITY_LABEL[rec.severity].toLowerCase()} interaction. ${rec.description}.`));
    } else {
      answer = h("div", { class: "answer-box answer-box--maybe" }, h("h4", null, "Maybe in the set, but the table says no"),
        h("p", null, `This is a false alarm. The values matched by coincidence, which happens for roughly 1 in ${Math.pow(2, bits)} pairs that are not listed. The table lookup catches it, so you would never see it.`));
    }

    el.labOutput.replaceChildren(
      h("ol", { class: "lab-steps" },
        labStep("Make the key", [h("p", null, "The two names are sorted, so aspirin with warfarin and warfarin with aspirin give the same key."), h("p", { class: "keyline" }, h("code", null, key))]),
        labStep("Hash the key", [
          h("p", null, `Hashing gives three things: a start slot (${info.start}), a ${db.ribbon.width}-bit pattern, and a ${bits}-bit fingerprint (${toBits(info.fingerprint, bits)}). The pattern below shows which of the ${db.ribbon.width} slots after the start are used, with offset 0 on the left.`),
          bitsRow(info),
        ]),
        labStep("Read the slots", [h("p", null, `The pattern has ${info.slots.length} ones, so the filter reads ${plural(info.slots.length, "slot")} between slot ${info.start} and slot ${info.end}.`), slotGrid(info)]),
        labStep("XOR them and compare", [
          h("p", { class: "xor-values" }, info.slots.map((s) => hex(s.value, bits)).join(" \u2295 ")),
          h("div", { class: "compare" },
            h("div", { class: "compare__cell" }, h("span", null, "XOR result"), h("b", null, toBits(info.xor, bits))),
            h("span", { class: "compare__sign", "aria-label": info.match ? "equals" : "does not equal" }, info.match ? "=" : "\u2260"),
            h("div", { class: "compare__cell" }, h("span", null, "Fingerprint"), h("b", null, toBits(info.fingerprint, bits)))),
        ]),
        labStep("Answer", answer)
      )
    );
  }

  function runLabLookup() {
    el.labHint.textContent = "";
    el.labHint.classList.remove("hint--error");
    const a = resolveDrug(el.labA.value);
    const b = resolveDrug(el.labB.value);
    const fail = (msg) => {
      el.labOutput.replaceChildren();
      el.labHint.textContent = msg;
      el.labHint.classList.add("hint--error");
    };
    if (!a || !b) return fail("Enter two medicine names.");
    if (a.generic === b.generic) return fail("Pick two different medicines.");
    renderLabOutput(a, b);
  }

  function renderLabQuick() {
    const buttons = [];
    const realKey = db.table.has("aspirin+warfarin") ? "aspirin+warfarin" : db.keys[0];
    buttons.push(h("button", { class: "btn btn--secondary", type: "button", onClick: () => openInLab(realKey) }, `A listed pair: ${realKey.replace("+", " + ")}`));

    const candidates = ["aspirin+paracetamol", "ibuprofen+paracetamol", "aspirin+metformin", "atenolol+paracetamol"];
    const notListed = candidates.find((k) => !db.table.has(k) && !db.ribbon.has(k)) || db.negativeKeys.find((k) => !db.ribbon.has(k));
    if (notListed) buttons.push(h("button", { class: "btn btn--secondary", type: "button", onClick: () => openInLab(notListed) }, `Not listed: ${notListed.replace("+", " + ")}`));

    if (db.falseAlarmKeys.length) {
      buttons.push(h("button", { class: "btn btn--secondary", type: "button", onClick: () => {
        const key = db.falseAlarmKeys[falseAlarmCursor % db.falseAlarmKeys.length];
        falseAlarmCursor++;
        openInLab(key);
      } }, "Show me a false alarm"));
    }
    el.labQuick.replaceChildren(...buttons);
  }

  /* ================= Lab: build steps ================= */
  function renderBuildSteps() {
    const rf = db.ribbon;
    const exampleKey = db.table.has("aspirin+warfarin") ? "aspirin+warfarin" : db.keys[0];
    const ex = rf.explain(exampleKey);
    const eq = ex.slots.slice(0, 5).map((s) => `Z[${s.index}]`).join(" \u2295 ") + (ex.slots.length > 5 ? ` \u2295 ... (${ex.slots.length} slots)` : "") + ` = ${toBits(ex.fingerprint, rf.fpBits)}`;

    const steps = [
      {
        label: "Turn each key into an equation",
        body: [
          h("h3", null, "Turn each key into an equation"),
          h("p", null, `Every listed pair is hashed into a start slot, a ${rf.width}-bit pattern and a ${rf.fpBits}-bit fingerprint. The equation says: the slots picked by the pattern, XORed together, must equal the fingerprint.`),
          h("p", null, `For ${exampleKey} that equation is:`),
          h("div", { class: "equation" }, eq),
        ],
      },
      {
        label: "Solve all equations together",
        body: [
          h("h3", null, "Solve all equations together"),
          h("p", null, `There are ${rf.n} equations and ${rf.m} unknown slots. Each equation only touches ${rf.width} neighbouring slots, so together they form a thin diagonal band, a ribbon. That shape lets Gaussian elimination over XOR solve the whole system quickly, with no multiplication.`),
          h("p", null, rf.attempts === 1 ? "This build worked on the first attempt." : `This build needed ${rf.attempts} attempts (different hash seeds or a few more slots) before a solution existed.`),
        ],
      },
      {
        label: "Keep only the slots",
        body: [
          h("h3", null, "Keep only the slots"),
          h("p", null, `The keys are thrown away. The filter is just ${rf.m} slots of ${rf.fpBits} bits: ${rf.sizeBits} bits, about ${rf.sizeBytes} bytes. That is ${rf.bitsPerKey.toFixed(1)} bits per stored pair.`),
          h("p", null, `Self-test: ${db.keys.length - db.missed} of ${db.keys.length} listed pairs are found by the filter. Missed pairs: ${db.missed}.`),
        ],
      },
      {
        label: "Look up a pair",
        body: [
          h("h3", null, "Look up a pair"),
          h("p", null, "Hash the key again, read the same slots, XOR them and compare with the fingerprint. A listed pair always matches, because the slots were solved to make that true."),
          h("p", null, `An unlisted pair only matches by luck, about 1 time in ${Math.pow(2, rf.fpBits)}. Out of ${db.negativeKeys.length} unlisted pairs among the medicines in this dataset, ${db.falseAlarmKeys.length} get a false alarm.`),
        ],
      },
    ];

    el.buildSteps.replaceChildren(
      ...steps.map((s, i) =>
        h("button", { class: "build-step", type: "button", "aria-pressed": String(i === buildStep), onClick: () => { buildStep = i; renderBuildSteps(); } }, h("b", null, String(i + 1)), s.label)
      )
    );
    el.buildBody.replaceChildren(
      ...steps[buildStep].body,
      h("div", { class: "build-nav" },
        h("button", { class: "btn btn--secondary", type: "button", disabled: buildStep === 0, onClick: () => { buildStep--; renderBuildSteps(); } }, "Back"),
        h("button", { class: "btn btn--secondary", type: "button", disabled: buildStep === steps.length - 1, onClick: () => { buildStep++; renderBuildSteps(); } }, "Next"))
    );
  }

  /* ================= Lab: tune ================= */
  function renderTune(bits) {
    el.bitsOut.textContent = String(bits);
    const rf = RibbonFilter.build(db.keys, { fpBits: bits });
    const bf = makeBloom(db.keys, bits);
    const total = db.negativeKeys.length;
    const rfp = db.negativeKeys.filter((k) => rf.has(k)).length;
    const bfp = db.negativeKeys.filter((k) => bf.has(k)).length;
    const missed = db.keys.filter((k) => !rf.has(k)).length;
    const maxBytes = Math.max(rf.sizeBytes, bf.sizeBytes);
    const saving = Math.round((1 - rf.sizeBytes / bf.sizeBytes) * 100);

    const col = (title, cls, f, fp, barCls) =>
      h("div", { class: "tune-col " + cls },
        h("h3", null, title),
        h("div", { class: "bar " + barCls, role: "img", "aria-label": `${title} size: ${f.sizeBytes} bytes` }, h("i", { style: `width:${Math.max(4, (f.sizeBytes / maxBytes) * 100)}%` })),
        h("dl", { class: "facts" },
          h("dt", null, "Size"), h("dd", null, `${f.sizeBytes} bytes`),
          h("dt", null, "Bits per pair"), h("dd", null, f.bitsPerKey.toFixed(1)),
          h("dt", null, "False alarms"), h("dd", null, `${fp} of ${total}`),
          h("dt", null, "Measured rate"), h("dd", null, pct(fp / total))));

    el.tuneOutput.replaceChildren(
      h("div", { class: "tune-grid" }, col("Ribbon filter", "tune-col--ribbon", rf, rfp, ""), col("Bloom filter", "", bf, bfp, "bar--bloom")),
      h("p", { class: "tune-note" },
        `Expected false alarm rate for ${bits} bits: about 1 in ${Math.pow(2, bits)}. `,
        saving > 0 ? `At this setting the Ribbon filter is ${saving}% smaller than the Bloom filter. ` : "",
        `Missed real pairs: ${missed} of ${db.keys.length}. Each extra bit roughly halves the false alarms and adds about one bit per pair.`)
    );
    el.tuneChart.replaceChildren(...tuneCharts(bits));
  }

  /* ================= Small charts (plain HTML, no libraries) ================= */
  function stackBar(parts) {
    const total = parts.reduce((t, p) => t + p.value, 0) || 1;
    return h("div", { class: "viz" },
      h("div", { class: "stackbar", role: "img", "aria-label": parts.map((p) => `${p.label}: ${p.value}`).join(", ") },
        parts.filter((p) => p.value).map((p) => h("i", { class: "seg seg--" + p.cls, style: `width:${(p.value / total) * 100}%` }))),
      h("ul", { class: "viz__legend" }, parts.map((p) => h("li", { class: "seg--" + p.cls }, h("b", null, String(p.value)), " ", p.label))));
  }

  /* ================= Lab: pipeline explorer ================= */
  let pipeStep = 2;
  function pipeStages() {
    const rf = db.ribbon;
    const samples = ["Crocin 500 mg tablet", "Ecosprin 75", "Warfarin"].map(resolveDrug).filter(Boolean);
    return [
      { label: "Medicine names", title: "You type names the way people really write them",
        points: [["Anything goes.", "Generic names, brand names such as Crocin, even strengths and words like tablet."], ["Nothing is dropped quietly.", "A name the dataset has never seen is marked \u201Cno data\u201D, so you know it was not checked."]],
        live: `The dataset covers ${plural(db.drugList.length, "medicine")} with known interactions and ${plural(db.brands.size, "brand name")}.` },
      { label: "Standardize", title: "Every name is cleaned up and every pair gets one key",
        points: [["Clean.", "Lower case, with strengths and tablet words removed."], ["Generic.", "Brand names are swapped for the generic medicine."], ["Sorted.", "The two names in a pair are sorted, so aspirin with warfarin and warfarin with aspirin give the same key."]],
        live: h("ul", { class: "mini-list" }, samples.map((d) => h("li", null, h("code", null, d.raw), " becomes ", h("strong", null, d.generic)))) },
      { label: "Ribbon filter", title: "A fast first answer",
        points: [["Fast \u201Cno\u201D.", "Most medicine pairs are not interactions. The filter rules them out without touching the table."], ["Small.", "The whole filter is a few hundred bytes, so it ships with the page and answers instantly."], ["Safe.", "It cannot miss a real interaction, and the table lookup removes false alarms before they reach you."]],
        live: `Here the whole filter is ${rf.m} slots of ${rf.fpBits} bits, about ${rf.sizeBytes} bytes.` },
      { label: "Table lookup", title: "The full table has the last word",
        points: [["Only for maybes.", "The table is read just for pairs the filter did not rule out."], ["Removes false alarms.", "A pair the table does not list is dropped, so it never reaches you."], ["Adds the detail.", "Severity and a plain description come from the table."]],
        live: `The table holds ${db.keys.length} interactions. With ${rf.fpBits}-bit fingerprints, ${db.falseAlarmKeys.length} of ${db.negativeKeys.length} unlisted pairs get a false alarm, and the table catches every one.` },
      { label: "Report", title: "You get a plain-language result",
        points: [["Headline first.", "Serious issues, needs a check, or no known interactions."], ["Charts.", "How the filter handled your pairs and how serious the matches are."], ["Next step.", "Each card says what to ask your doctor or pharmacist. A clear result is not proof that a combination is safe."]],
        live: "Run a check on the Checker tab to see a real report." },
    ];
  }

  function renderPipe() {
    const stages = pipeStages();
    const s = stages[pipeStep];
    el.pipeSteps.replaceChildren(...stages.map((st, i) =>
      h("button", { class: "pipe__step", type: "button", role: "tab", id: "pipe-tab-" + i, "aria-selected": String(i === pipeStep), "aria-controls": "pipe-body", tabindex: i === pipeStep ? "0" : "-1", onClick: () => { pipeStep = i; renderPipe(); } },
        i ? h("span", { class: "pipe__arrow", "aria-hidden": "true" }, "\u203A") : null, st.label)));
    el.pipeBody.setAttribute("aria-labelledby", "pipe-tab-" + pipeStep);
    el.pipeBody.replaceChildren(
      h("h3", null, s.title),
      h("ul", { class: "reasons" }, s.points.map(([b, t]) => h("li", null, h("strong", null, b), " ", t))),
      typeof s.live === "string" ? h("p", { class: "pipe__live" }, s.live) : s.live,
      h("div", { class: "pipe__nav" },
        h("button", { class: "btn btn--secondary", type: "button", disabled: pipeStep === 0, onClick: () => { pipeStep--; renderPipe(); } }, "Previous step"),
        h("button", { class: "btn btn--secondary", type: "button", disabled: pipeStep === stages.length - 1, onClick: () => { pipeStep++; renderPipe(); } }, "Next step")));
  }

  /* ================= Lab: size and accuracy charts ================= */
  let tuneSeries = null;
  function getTuneSeries() {
    if (tuneSeries) return tuneSeries;
    tuneSeries = [];
    const n = db.negativeKeys.length || 1;
    for (let b = 4; b <= 12; b++) {
      const rf = RibbonFilter.build(db.keys, { fpBits: b });
      const bf = makeBloom(db.keys, b);
      tuneSeries.push({ bits: b, rs: rf.sizeBytes, bs: bf.sizeBytes, rfp: db.negativeKeys.filter((k) => rf.has(k)).length / n, bfp: db.negativeKeys.filter((k) => bf.has(k)).length / n });
    }
    return tuneSeries;
  }

  function pairBars(title, note, rows, fmt) {
    const max = Math.max(...rows.map((r) => Math.max(r.a, r.b))) || 1;
    const bar = (v, cls) => h("span", { class: "pb__bar " + cls }, h("i", { style: `width:${Math.max(2, (v / max) * 100)}%` }), h("em", null, fmt(v)));
    return h("div", { class: "viz-block" },
      h("h3", null, title), h("p", { class: "note" }, note),
      h("div", { class: "pb" }, rows.map((r) => h("div", { class: "pb__row" + (r.on ? " pb__row--on" : ""), "aria-current": r.on ? "true" : null }, h("span", null, r.label), bar(r.a, ""), bar(r.b, "pb__bar--bloom")))),
      h("ul", { class: "viz__legend" }, h("li", { class: "seg--brand" }, "Ribbon filter"), h("li", { class: "seg--bloom" }, "Bloom filter")));
  }

  function tuneCharts(bits) {
    const s = getTuneSeries();
    return [
      pairBars("Size at each fingerprint length", "Bytes needed. The row for your slider setting is highlighted.", s.map((x) => ({ label: x.bits + " bits", a: x.rs, b: x.bs, on: x.bits === bits })), (v) => v + " B"),
      pairBars("False alarms at each fingerprint length", "Share of unlisted pairs that get a false \u201Cmaybe\u201D. Both filters are built for the same target rate.", s.map((x) => ({ label: x.bits + " bits", a: x.rfp, b: x.bfp, on: x.bits === bits })), pct),
    ];
  }

  /* ================= Lab: session stats ================= */
  function sessionParts(s) {
    return [{ label: "ruled out by the filter", value: s.skipped, cls: "no" }, { label: "false alarms", value: s.falseAlarms, cls: "mod" }, { label: "confirmed interactions", value: s.confirmed, cls: "major" }];
  }

  function renderSessionStats() {
    const s = state.session;
    if (!s.checks) {
      el.sessionStats.replaceChildren(h("p", null, "Run a check on the Checker tab and the totals for this session appear here."));
      el.sideSession.replaceChildren(h("p", null, "No checks yet. Run one to see the filter at work."));
      return;
    }
    el.sessionStats.replaceChildren(
      h("p", null, `This session: ${plural(s.checks, "check")}, ${plural(s.pairs, "pair")} looked up. The filter said \u201Cdefinitely not\u201D for ${s.skipped}, which skipped the table entirely. Of ${s.maybe} \u201Cmaybe\u201D answers, ${s.confirmed} were real and ${s.falseAlarms} were false alarms caught by the table.`),
      stackBar(sessionParts(s))
    );
    el.sideSession.replaceChildren(h("p", { class: "side-title" }, "This session"), stackBar(sessionParts(s)));
  }

  /* ================= Example data ================= */
  function loadExample() {
    state.drugs = [];
    state.allergies = new Set(["penicillin"]);
    for (const name of ["warfarin", "Ecosprin", "Crocin", "amoxicillin"]) {
      const d = resolveDrug(name);
      if (d && !state.drugs.some((x) => x.generic === d.generic)) state.drugs.push(d);
    }
    setHint("");
    onInputChanged();
  }

  /* ================= Boot ================= */
  function wireEvents() {
    el.form.addEventListener("submit", (e) => {
      e.preventDefault();
      if (addDrug(el.input.value)) el.input.value = "";
      el.input.focus();
    });
    el.checkBtn.addEventListener("click", runCheck);
    el.exampleBtn.addEventListener("click", loadExample);
    el.clearBtn.addEventListener("click", () => {
      state.drugs = [];
      state.allergies = new Set();
      setHint("");
      onInputChanged();
    });
    el.skipBtn.addEventListener("click", () => {
      skipAnimation = true;
      el.skipBtn.hidden = true;
    });

    el.tabChecker.addEventListener("click", () => showTab("checker"));
    el.tabLab.addEventListener("click", () => showTab("lab"));
    for (const tab of [el.tabChecker, el.tabLab]) {
      tab.addEventListener("keydown", (e) => {
        if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(e.key)) return;
        const toLab = tab === el.tabChecker;
        showTab(toLab ? "lab" : "checker");
        (toLab ? el.tabLab : el.tabChecker).focus();
      });
    }

    el.pipeSteps.addEventListener("keydown", (e) => {
      const d = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
      if (!d || !db) return;
      pipeStep = (pipeStep + d + 5) % 5;
      renderPipe();
      $("pipe-tab-" + pipeStep).focus();
    });

    el.labForm.addEventListener("submit", (e) => {
      e.preventDefault();
      runLabLookup();
    });
    el.bitsRange.addEventListener("input", () => renderTune(Number(el.bitsRange.value)));
  }

  function enableUI() {
    for (const node of [el.input, el.addBtn, el.checkBtn, el.exampleBtn, el.labA, el.labB, el.labGo, el.bitsRange]) node.disabled = false;
  }

  function showLoadError(err) {
    el.loadError.hidden = false;
    el.loadError.replaceChildren(
      h("strong", null, "Could not load data/interactions.json. "),
      "Browsers block this when index.html is opened by double-clicking it. Start a local server in the project folder (for example ",
      h("code", null, "python -m http.server 8000"),
      ") and open ",
      h("code", null, "http://localhost:8000"),
      "."
    );
    el.hint.textContent = "Dataset not loaded.";
    el.hint.classList.add("hint--error");
    console.error(err);
  }

  async function init() {
    buildProcessShell();
    el.results.replaceChildren(emptyResults());
    wireEvents();
    try {
      const res = await fetch(DATA_URL);
      if (!res.ok) throw new Error("HTTP " + res.status);
      db = buildDatabase(await res.json());
    } catch (err) {
      showLoadError(err);
      return;
    }
    el.datalist.replaceChildren(...[...db.drugList, ...db.brands.keys()].sort().map((n) => h("option", { value: n })));
    renderChips();
    renderAllergyToggles();
    renderInputStage();
    renderLabQuick();
    renderBuildSteps();
    renderPipe();
    renderTune(FP_BITS);
    renderSessionStats();
    setHint(`Dataset ready: ${db.keys.length} interactions. Type a name and press Enter.`);
    enableUI();
  }

  init();
})();
