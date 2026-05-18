# Insurance Verification Waterfall

**Status:** Proposed — Partially built  
**Branch:** Dispatch Package → Insurance  
**ADR:** `docs/adr/ADR-0004-insurance-verification-waterfall.md`  
**Last updated:** May 18, 2026

---

## Position in the CC Spine

```
Broker creates load
  → generates load apply link
  → posts link on DAT / Truckstop

Carrier clicks link
  → enters MC number
  → passes FMCSA screen
  → submits name / phone / email / SMS consent

Broker reviews applicants → assigns one

CC sends confirmation link → carrier confirms driver + truck

  ┌─────────────────────────────────────────────┐
  │  CC evaluates the confirmed dispatch package │
  │                                              │
  │  ├── CDL branch                              │
  │  ├── Cab card branch                         │
  │  └── *** Insurance branch (this spec) ***    │
  └─────────────────────────────────────────────┘

CLEAR / REVIEW / DO NOT DISPATCH → arrival signal
```

The insurance waterfall runs in parallel with CDL and cab card evaluation. It begins after the carrier has confirmed a specific driver and truck for a load.

**Secondary path:** Broker enters MC + phone directly → CC sends SMS magic link → same Steps 1–6 run.

---

## Step 1 — Certificate of Insurance Collection

**Trigger:** Carrier has confirmed driver and truck for this load.

1. CC checks whether this carrier already has a current COI on file from a previous verification. If valid and not expired → skip to Step 2.
2. If expired or missing → carrier is prompted to upload their Certificate of Insurance (ACORD 25 or equivalent) through the verification form.

> Repeat carriers with current documents on file skip re-uploading. CC only asks for what's expired or missing.

**Build status:** ✅ Built — COI upload via SMS magic link, carrier profile document caching.

---

## Step 2 — OCR Extraction and Parsing

**Trigger:** COI received.

1. CC runs OCR on the COI and extracts:
   - Policy number
   - Insurer name and NAIC code
   - Named insured (legal entity on the policy)
   - Coverage types and which auto boxes are checked (Any Auto, Scheduled Autos, Hired, Non-Owned)
   - Effective and expiration dates
   - Coverage amounts (combined single limit, cargo, general liability)
   - Any VINs listed anywhere in the document — including ACORD 101 additional remarks pages

2. **Document confidence check.** If OCR cannot reliably parse the expiration date, coverage amount, or VIN field → result is **REVIEW**, not CLEAR. CC does not guess on unreadable documents.

**Outcomes:**
- OCR confidence too low on critical fields → **REVIEW**. Broker shown the specific field that couldn't be parsed and the raw document.

**Build status:** 🟡 Partially built — OCR extraction exists. Confidence scoring and REVIEW tier not built yet. ACORD 101 multi-page scanning not built yet.

### Parsed Fields Target

These fields should be stored in `carrier_documents.parsed_data` for document type `certificate_of_insurance`:

| Field | Type | Source |
|-------|------|--------|
| `policy_number` | string | COI body |
| `insurer_name` | string | COI Insurer A/B/C rows |
| `insurer_naic` | string | COI Insurer NAIC column |
| `named_insured` | string | COI Insured block |
| `auto_coverage_type` | enum: `any_auto`, `scheduled`, `hired`, `non_owned`, `owned` | COI auto liability checkboxes |
| `combined_single_limit` | number | COI auto liability limits |
| `general_aggregate` | number | COI general liability limits |
| `cargo_limit` | number | COI motor truck cargo limits |
| `cargo_deductible` | number | COI motor truck cargo limits |
| `policy_effective` | date | COI policy eff column |
| `policy_expiration` | date | COI policy exp column |
| `vins_found` | string[] | COI description, ACORD 101 remarks |
| `has_pending_cancellation` | boolean | COI description |
| `ocr_confidence` | object | Per-field confidence scores |

---

## Step 3 — Policy Validation

**Trigger:** OCR extraction complete with sufficient confidence.

1. **Named insured match.** The legal entity on the COI must match the carrier's FMCSA-registered legal name or DBA. Mismatch → flag.
2. **Insurance expiration check.** Is the policy active and current as of today? Expired → flag.
3. **Coverage amount check.** Does the auto liability meet the broker's configured minimum threshold? Each broker sets their own floor.
4. **Cargo coverage check.** If the broker requires motor truck cargo coverage, verify it's present and meets the broker's minimum. Check deductible amount.

**Outcomes:**
- Policy expired → **DO NOT DISPATCH**
- Named insured doesn't match FMCSA record → **REVIEW**. Broker shown both names.
- Coverage below broker's configured threshold → **REVIEW** with specifics.

> Coverage thresholds are broker-configurable. One broker might require $1M CSL and $100K cargo. Another might require $750K. CC checks against the broker's own policy.

**Build status:** 🟡 Partially built — Expiration checking exists. Named insured matching, broker-configurable thresholds, and cargo coverage checking not built yet.

### Broker Coverage Configuration Target

```
broker_settings.insurance_requirements:
  auto_liability_min: 1000000        # combined single limit floor
  cargo_coverage_required: true
  cargo_limit_min: 100000
  cargo_deductible_max: 5000
  general_liability_min: null         # null = not checked
```

---

## Step 4 — VIN Cross-Reference

**Trigger:** Policy validation passed. Now answering: is this specific truck covered?

1. CC checks which auto coverage box is marked on the COI.

2. **"Any Auto" checked:** Blanket coverage — all vehicles in the carrier's fleet are covered regardless of VIN. VIN match not required. → Step 6.

3. **"Scheduled Autos" + VINs listed:** OCR scans all pages (including ACORD 101 remarks) for VINs. Cross-references the confirmed truck's VIN (from the cab card) against every VIN found on the COI. Match = covered. No match = flag.

4. **"Scheduled Autos" + no VINs found:** The COI does not contain enough information to confirm whether this specific truck is covered. → Step 5.

**Outcomes:**
- "Any Auto" → blanket coverage confirmed. Skip to Step 6.
- VIN match found → this truck is covered. Proceed to Step 6.
- VIN found on COI but doesn't match the confirmed truck → **REVIEW**. Broker shown both VINs.
- Scheduled Autos but no VINs anywhere in document → proceed to Step 5.

**Build status:** 🔴 Not built — Any Auto vs Scheduled Autos parsing, VIN cross-reference against cab card, multi-page VIN extraction.

### Evaluator Logic Target

```
function evaluateVinCoverage(parsedCoi, confirmedVin):
  if parsedCoi.auto_coverage_type === 'any_auto':
    return { result: 'CLEAR', reason: 'blanket_coverage' }

  if parsedCoi.vins_found.length === 0:
    return { result: 'NEEDS_DEC_PAGE', reason: 'no_vins_on_coi' }

  if parsedCoi.vins_found.includes(confirmedVin):
    return { result: 'CLEAR', reason: 'vin_match' }

  return {
    result: 'REVIEW',
    reason: 'vin_mismatch',
    coi_vins: parsedCoi.vins_found,
    confirmed_vin: confirmedVin
  }
```

---

## How Step 4 Handles Real Certificates

The same ACORD 25 form presents vehicle coverage differently. These are three real certificates from Kate's workflow:

### Signature Brand Logistics LLC
"Scheduled Autos" checked. Two specific vehicles with full VINs in the Description of Operations: a 2018 Freightliner Cascadia (3AKJHHDR0JSJX2126) and a 2011 Great Dane (1GRAA0620BD439761). VINs are explicit and parseable.

→ OCR extracts VINs, cross-references against confirmed truck's VIN. Direct match = **CLEAR**. (Step 4 → 6)

### KIK LLC
"Scheduled Autos" checked on page 1, no VINs in the main body. One VIN (3AKJHHDRXNSNH6763) found in the ACORD 101 Additional Remarks on page 2. Cert notes pending cancellation on auto liability (eff 5/11/2026).

→ OCR scans all pages including ACORD 101. Finds VIN in remarks. Cross-references against cab card. Pending cancellation flagged separately at Step 3. (Step 4 → 6)

### Phamile 1st LLC
"Scheduled Autos" checked. Description of Operations blank. No VINs anywhere. No ACORD 101 attachment. No way to determine vehicle coverage from this cert alone.

→ Cannot verify vehicle coverage. Proceeds to Step 5 — Declarations Page Request. (Step 4 → 5)

---

## Step 5 — Declarations Page Request

**Trigger:** COI does not contain enough information to verify vehicle coverage.

1. CC sends the carrier a follow-up message: *"We need one more document to complete your insurance verification. Please upload your policy declarations page showing covered vehicles."*
2. Carrier uploads the declarations page. This is the insurer-issued source of truth — it either lists every covered VIN or explicitly states blanket coverage.
3. OCR reads the declarations page and either confirms blanket coverage or extracts VINs for cross-reference against the confirmed truck.

**Outcomes:**
- Blanket coverage confirmed via dec page, or VIN match found → proceed to Step 6.
- Dec page uploaded but VIN doesn't match → **REVIEW**. Broker shown both VINs and dec page data.
- Carrier does not provide dec page within time window → **NO RESPONSE — DO NOT DISPATCH**.

> The declarations page is a fourth document type alongside COI, CDL, and cab card. It is only requested when the COI is ambiguous.

**Build status:** 🔴 Not built — declarations_page document type, "needs dec page" state, follow-up SMS trigger.

---

## Step 6 — Insurance Clearance Result

**Trigger:** All insurance checks complete.

1. CC compiles the insurance evaluation into a clearance result that feeds back into the Dispatch Package alongside CDL and cab card results.
2. The insurance reasoning is shown to the broker in the dashboard: which checks passed, which flagged, and why. Not just a status badge — the broker sees the logic.
3. If this carrier verified with current documents, the insurance result is cached on the carrier profile. Future verifications reuse current documents — only expired or changed items are re-requested.

**Build status:** 🟡 Partially built — Result delivery exists. Insurance-specific reasoning display not built yet.

---

## Escalation Timeline — Non-Response

| Time | Action |
|------|--------|
| 0 min | Document request sent to carrier (COI or declarations page). |
| 15 min | No response. Carrier receives a reminder. |
| 30 min | Still no response. Broker notified — carrier has not provided documents. |
| 60 min | No response. Result: **NO RESPONSE — DO NOT DISPATCH**. Broker shown reason. |

The same escalation clock applies to both the initial COI request and the declarations page follow-up in Step 5.

**Build status:** ✅ Built — 15/30/60 escalation cron.

---

## Clearance Results

### CLEAR
Insurance verified. Policy active, named insured matches FMCSA record, coverage meets broker's configured thresholds, and the confirmed truck is covered (VIN match or blanket). Insurance branch passes to the Dispatch Package.

### REVIEW
Something needs a human look. Possible reasons:
- Named insured doesn't match FMCSA record
- VIN on cab card doesn't match any VIN on the COI
- Coverage below broker's threshold
- OCR couldn't parse a critical field with confidence
- Pending cancellation noted on the cert

Broker sees the specific issue and the raw document.

### DO NOT DISPATCH
Hard failure. Policy expired, or carrier did not provide requested documents within the time window. Broker shown the reason. Not a judgment call.

---

## What This Is and Is Not

**This is document-based verification.** CC reads the insurance documents the carrier provides, extracts structured data via OCR, and cross-references it against the confirmed truck and the broker's coverage requirements. It catches expired policies, VIN mismatches, coverage gaps, named-insured discrepancies, and missing documents automatically.

**This is not insurer-confirmed coverage.** CC does not call the insurance company or query an insurer API to verify that a policy is active on the insurer's side. If a carrier uploads a valid-looking document for a policy that was cancelled yesterday and the cancellation isn't noted on the cert, CC would not catch that. Insurer-level verification is a future enhancement.

---

## Build Priority

1. Add insurance-specific evaluation fields to `carrier_documents.parsed_data`
2. Teach evaluator: Any Auto = VIN match not required; Scheduled Autos + VIN match = CLEAR; Scheduled Autos + no VIN = request dec page; VIN mismatch = REVIEW
3. Add `declarations_page` as a fourth upload type
4. Add "needs dec page" state and SMS follow-up
5. Add named insured matching against FMCSA legal name
6. Add broker-configurable coverage thresholds
7. Add OCR confidence scoring → REVIEW on low confidence
8. Show insurance reasoning in broker dashboard
