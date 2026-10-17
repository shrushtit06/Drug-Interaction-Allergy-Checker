# Drug-Interaction-Allergy-Checker
Interactive drug interaction and allergy checker built with HTML, CSS and JavaScript, featuring step-by-step analysis, a Ribbon filter for fast lookups, allergy detection, and filter performance visualization.
# 💊 Drug Interaction & Allergy Checker

<p align="center">
  <b>Interactive Web Application for Drug Interaction Checking, Allergy Detection & Fast Filtering</b>
</p>

<p align="center">

![HTML](https://img.shields.io/badge/HTML5-E34F26?logo=html5&logoColor=white)
![CSS](https://img.shields.io/badge/CSS3-1572B6?logo=css3&logoColor=white)
![JavaScript](https://img.shields.io/badge/JavaScript-F7DF1E?logo=javascript&logoColor=black)
![JSON](https://img.shields.io/badge/Data-JSON-000000?logo=json)
![Algorithm](https://img.shields.io/badge/Algorithm-Ribbon%20Filter-purple)

</p>

---

## 📌 Project Overview

**Drug Interaction & Allergy Checker** is an interactive web application that allows users to enter multiple medicines and selected allergies to identify potential drug interactions and allergy-related warnings.

The application goes beyond simply displaying a result. It visually explains the steps involved in checking the medicines, including:

- 🧹 Medicine name normalization
- 🔗 Pair generation
- ⚡ Ribbon filter lookup
- 🔍 Full interaction-table confirmation
- ⚠️ Allergy checking
- 📋 Result generation

The project also contains an interactive **Ribbon Filter Lab** that demonstrates how probabilistic filtering can reduce unnecessary table lookups.

> ⚠️ **Disclaimer:** This is an educational learning project using a small hand-curated dataset. It is **not a medical tool**, does not replace professional medical advice, and should not be used for real-world medication decisions.

---

# ✨ Features

## 💊 1. Drug Interaction Checker

Users can enter multiple medicines into the application.

The system:

- Accepts medicine names
- Normalizes medicine names
- Recognizes supported brand names
- Removes duplicate medicines
- Generates medicine pairs
- Checks each pair for known interactions
- Classifies interactions by severity

Supported severity levels include:

- 🔴 **Major**
- 🟠 **Moderate**
- 🟢 **Minor**

---

## ⚠️ 2. Allergy Checker

Users can select allergy groups such as:

- Penicillins
- Cephalosporins
- Sulfa drugs
- NSAID painkillers
- Opioids
- Macrolides
- Fluoroquinolones
- Tetracyclines
- Aromatic anticonvulsants

The application compares selected allergies with the medicines entered by the user.

It also includes cross-reactivity warnings for selected allergy groups.

---

## 🔎 3. Medicine Name Normalization

The application cleans medicine input before checking it.

For example, the system can normalize inputs containing:

- Dosage information
- Units such as `mg`, `mcg`, `g`, `ml`
- Tablet/capsule wording
- Special characters
- Extra spaces

This allows different ways of entering a medicine to be mapped to a common representation.

---

## ⚡ 4. Ribbon Filter

The project implements a **Ribbon Filter** to perform fast probabilistic membership checks.

Instead of immediately searching the complete interaction table for every medicine pair, the filter first determines whether the pair is:

### ❌ Definitely Not

The pair cannot be present in the interaction dataset.

The application can skip the full table lookup.

### ❓ Maybe

The pair may exist in the interaction dataset.

The application performs a confirmation lookup in the full table.

This creates a two-stage checking process:

```text
Medicine Pair
      ↓
Ribbon Filter
      ↓
 ┌───────────────┐
 │               │
Definitely Not   Maybe
 │               │
 ↓               ↓
Skip Lookup   Full Table
                Lookup
                   ↓
             Confirm Result
