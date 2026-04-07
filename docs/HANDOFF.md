# Connected Carriers / HoneXAI — Project Handoff
**Date:** April 7, 2026  
**From:** This session (LTL Reconciliation + HONEX Platform)  
**To:** HONEX Project (GitHub connected)

---

## 1. BRAND ARCHITECTURE (DECIDED)

| Brand | Domain | Role |
|-------|--------|------|
| **HoneXAI** | honexai.com | Parent platform / technology company |
| **Connected Carriers** | connectedcarriers.org (owned) | Consumer-facing carrier network product |
| HONEX | honex.com | Existing site services brand — separate |

**Domain moat owned:** honex.com, honnex.com, honexai.com, honex.ai + variations  
**connectedcarriers.com** — redirects to hotshottrucking.com (too expensive for MVP)  
**connectedcarrier.com** (singular) — available for ~$3,200, not needed for MVP  

**Wordmark direction (HoneXAI):**  
- Serif regular font (Liberation Serif)  
- "Hone" and "XAI" same weight, same font  
- XAI slightly larger than Hone — subtle, unified  
- Final file: `honexai_final.png` (in outputs)

**Wordmark direction (Connected Carriers):**  
- Option 3 selected: CC monogram in solid square block + wordmark beside  
- File: `connectedcarriers_wordmarks.png` (in outputs)

---

## 2. CONNECTED CARRIERS LANDING PAGE (BUILT)

**File:** `connected_carriers.html`  
**Status:** Complete, ready to deploy  
**Live form URL:** https://docs.google.com/forms/d/1NF5Aj785sYcd8UOdaPifw8NthLGPLu9iJMWdzSbAPxM/viewform

**Design system:**
```
--slate:   #1C2B3A   (primary dark)
--slate2:  #243447
--slate3:  #2E4058
--amber:   #C8892A   (accent — nobody in freight uses this)
--amber2:  #E09B35
--cream:   #F7F5F0   (warm off-white background)
--cream2:  #EDE9E1
--ink:     #141414
--serif:   Playfair Display
--sans:    DM Sans
```

**Page structure:**
1. Fixed nav — wordmark + links + Apply Now CTA
2. Hero — dark slate, skewed panel, animated fade-up
3. Trust bar — 5 credibility stats on cream band
4. 3 value cards — white on cream, amber hover accent line
5. How it works — 3 steps on dark slate, amber connecting line
6. Split panel — dark left (brokers) / light right (carriers)
7. CTA band — amber background, CC watermark
8. Footer — very dark, HoneXAI attribution

**What to strip out before GitHub push:**
- Nothing site-services specific is in this file
- All CTAs already point to the Google Form
- Footer already says "A HoneXAI product"

---

## 3. GOOGLE FORM (LIVE)

**Form name:** HONEX Connected Carriers — Carrier Qualification Profile  
**Edit URL:** https://docs.google.com/forms/d/1NF5Aj785sYcd8UOdaPifw8NthLGPLu9iJMWdzSbAPxM/edit  
**Share URL:** https://docs.google.com/forms/d/1NF5Aj785sYcd8UOdaPifw8NthLGPLu9iJMWdzSbAPxM/viewform  
**Response sheet:** "HONEX Connected Carriers — Responses" (auto-created in Drive)  
**Script file:** `HONEX_ConnectedCarriers_Form.gs` (in outputs)

**Form covers 11 sections:**
1. About You (who is filling this out)
2. Compliance & Legal Authority
3. Insurance Requirements
4. Equipment & Capacity
5. Performance Standards
6. Rate Submission & Payment Terms
7. Automatic Disqualifiers
8. Carrier Tiers (with full tier descriptions)
9. Notifications
10. Dispatch Verification (VIN, driver, checklist)
11. Current Software & Tools Inventory

**Key design decisions:**
- Multiple team members can submit separately
- No limit on responses per user
- Progress bar enabled
- All text fields unlimited length
- Responses auto-collect in Google Sheet

---

## 4. CARRIER QUALIFICATION WORKSHEET PDF (BUILT)

**File:** `Carrier_Qualification_Worksheet_COMPLETE.pdf` (5-page fillable)  
**Built with:** WeasyPrint (HTML to PDF)  
**Source:** `worksheet.html`

**Pages:**
1. Compliance, Insurance, Equipment
2. Performance, Rates & Payment, Auto-Disqualifiers
3. Carrier Tiers (with descriptions), Notifications, Special Cases
4. Dispatch Step — Driver info, VIN fields, checklist, automation options
5. SaaS & Tools Inventory

**Note:** Authorized By section removed per request. WeasyPrint produces static PDF — not truly fillable. For fillable version use the Google Form.

---

## 5. CARRIER TIERS (SYSTEM DESIGN)

| Tier | Who | What Happens |
|------|-----|--------------|
| **Tier 1 — Preferred** | In Port TMS + 3+ loads + clean history | Bypasses screening, pre-approved |
| **Tier 2 — Approved** | New carrier, passes all hard stops | Standard onboarding, team notified |
| **Tier 3 — Conditional** | Passes minimums, needs review | Manual review queue, team alerted |
| **Rejected** | Fails any auto-disqualifier | Instant rejection, optional auto-response |

---

## 6. VERIFICATION LAYER (ARCHITECTURE)

**At submission (automated):**
- FMCSA SAFER API — MC#, DOT, authority status, safety rating, years in business
- Auto-tier assignment based on Port TMS history + FMCSA data

**At dispatch (automated):**
- VIN vs FMCSA registered fleet for that MC#
- Re-verify insurance active at dispatch moment
- VIN vs CargoNet stolen vehicle database
- Alert team if any check fails

**Insurance verification reality:**
- No direct API into insurance companies
- FMCSA SAFER API (free) confirms minimum coverage on federal record
- Highway / SaferWatch (paid) — real-time monitoring, lapse alerts
- COI PDFs reviewed manually or via OCR

**Recommended services:**
- Highway (highway.com) — all-in-one, most comprehensive
- CargoNet — cargo theft / stolen vehicle database
- FMCSA SAFER API — free, federal data
- MyCarrierPackets/MyCarrierPortal — acquired by Descartes, enterprise

---

## 7. COMPETITIVE LANDSCAPE SUMMARY

| Player | Visual Identity | Weakness |
|--------|----------------|----------|
| MyCarrierPortal | Corporate blue, compliance-heavy | Acquired by Descartes, enterprise feel |
| Highway | Dark, security-tech aesthetic | Carrier-hostile feel despite "for carriers" push |
| RMIS/SaferWatch | Truckstop teal/green, utilitarian | $340+/mo, mid-to-enterprise only |
| Carrier411 | Aging, legacy interface (2005) | Being displaced, $149-299/mo |
| Vector | Enterprise SaaS gray | Document workflow, not carrier onboarding |
| CarrierOwl | No real brand | Free, bare bones |

**White space:** Warm, trustworthy, carrier-friendly network aesthetic. Nobody using slate + amber + warm cream. Nobody speaking to both brokers AND carriers simultaneously in the same product.

---

## 8. PRODUCT ROADMAP

```
Layer 1 (NOW):  Carrier qualification portal — building this
Layer 2 (NEXT): Performance memory per carrier per load
Layer 3:        Network intelligence across multiple brokers
Layer 4:        Load marketplace for pre-screened carriers
```

**The moat:** Every carrier submission, every qualification decision, every performance data point = a dataset no public database has. Broker-verified, experience-based carrier intelligence organized by lane, equipment, and history across independent brokers.

**HoneXAI** = the technology company  
**Connected Carriers** = the consumer network it runs  
**honex.ai** = where the intelligence layer eventually lives

---

## 9. KATE'S LOGISTICS XPRESS DATA (COMPLETED WORK)

This was the original project that spawned everything:

**LTL Reconciliation:**
- 529 Speed Ship records, 528 NOT in Port TMS
- File: `LTL_Reconciliation_Final2.xlsx`
- Created By: kate@ (364), API (141), Worldwide Express (11), joe@ (3), justin@ (2)

**Lane Intelligence:**
- 7,804 loads, Apr 2025–Apr 2026
- File: `Lane_Intelligence.xlsx`
- Avg margin: 15.3% (~$298/load)
- Top customer: Turbo Wholesale Tires (1,412 loads)
- Top carrier: J.B. Hunt (1,009 loads)
- Thinnest lane: Thailand→Irwindale CA (524 loads, 4.5% margin)

---

## 10. FILES TO BRING OVER

### Must bring:
- `connected_carriers.html` — landing page (ready to deploy)
- `HONEX_ConnectedCarriers_Form.gs` — Google Apps Script
- `honexai_final.png` — HoneXAI wordmark (light)
- `honexai_wordmark_dark.png` — HoneXAI wordmark (dark)
- `connectedcarriers_wordmarks.png` — CC wordmark options (option 3 selected)

### Reference only (don't deploy):
- `Carrier_Qualification_Worksheet_COMPLETE.pdf`
- `worksheet.html` — source for PDF
- `LTL_Reconciliation_Final2.xlsx`
- `Lane_Intelligence.xlsx`

---

## 11. CALENDAR REMINDERS ALREADY SET

| Date | Reminder |
|------|----------|
| April 9, 2026 | Follow up with Kate — send her the Google Form link |
| April 14, 2026 | Review HONEX site services assets for Connected Carriers reuse |

---

## 12. IMMEDIATE NEXT STEPS (IN HONEX PROJECT)

1. **GitHub** — create repo `connected-carriers`, push `index.html` (renamed from `connected_carriers.html`)
2. **Deploy** — connect repo to Netlify or Railway for auto-deploy
3. **DNS** — point connectedcarriers.org at the deployed URL in GoDaddy
4. **HONEX site services review** — look at existing GitHub code, strip anything site-services specific, pull reusable components into Connected Carriers
5. **Kate's form** — send her the Google Form link (April 9 reminder set)

---

*Generated April 7, 2026 — end of LTL Reconciliation / HONEX Platform session*
