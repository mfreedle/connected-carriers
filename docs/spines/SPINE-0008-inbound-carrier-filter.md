# SPINE-0008: Inbound Carrier Filter

**Status:** Built and smoke tested
**Owner:** Broker app
**Core question this answers for Kate:** "Which of these unknown carriers are worth my time?"

---

## The Problem

Kate posts a load on DAT. Unknown carriers flood in. Every one of them is an unvetted stranger. Before CC, she had to manually look up each MC in Carrier411, check FMCSA, check authority, check insurance status — before she even knew if they were worth a phone call.

Carrier411 monitors carriers Kate already knows. Tai manages carriers already in her TMS. Neither helps her filter the inbound strangers.

## The Wedge

CC flips the work. The carrier clicks Kate's link, enters their MC, and the system screens them instantly. By the time Kate looks at her dashboard, the unqualified carriers are already gone. She's only seeing carriers who passed the FMCSA gate and expressed real interest.

**Kate didn't make a single phone call or run a single lookup to get there.**

## Flow

1. Kate creates a load in the dashboard
2. System generates a `/l/:slug` link
3. Kate pastes the link in her DAT posting notes (or texts it to a carrier)
4. Carrier clicks the link → sees load details (route, equipment, date)
5. Carrier enters MC number
6. System runs instant FMCSA check:
   - Active authority? Active USDOT? Safety rating?
   - If not qualified: "Not Qualified" — carrier sees why, Kate never sees them
   - If qualified: carrier sees "Qualified" and can submit interest
7. Carrier submits name + phone + email
8. Kate gets an SMS: "New carrier interest on HX-0513-19EE"
9. Kate's dashboard shows ranked applicants:
   - Dispatch-ready carriers first (profile on file, docs current)
   - Qualified + phone (FMCSA pass, contact info, no profile yet)
   - Review (conditional safety rating or edge case)

## What's Built

| Component | Location | Status |
|-----------|----------|--------|
| Load creation | `canonical-loads.ts` POST /api/v2/loads/create | ✅ |
| Public apply page | `canonical-loads.ts` GET /l/:slug | ✅ |
| MC qualification check | `canonical-loads.ts` POST /l/:slug/check | ✅ |
| FMCSA lookup | `lib/fmcsa.ts` lookupFMCSA() | ✅ |
| Carrier identity resolution | `carrier-identity.ts` findOrCreateCarrier() | ✅ |
| Interest submission | `canonical-loads.ts` POST /l/:slug/interest | ✅ |
| Broker SMS notification | In interest handler | ✅ |
| Applicant ranking | v2 applicants endpoint, ORDER BY dispatch readiness | ✅ |
| Attention panel | v2 attention endpoint | ✅ |
| SMS consent on submission | carrier_consents table | ✅ |

## Design Rules

- The carrier does the work, not Kate
- Unqualified carriers never reach Kate's dashboard
- The apply page should feel like checking on a load, not joining a platform
- FMCSA check is a gate, not a compliance tool — Carrier411 handles ongoing monitoring
- Contact info is captured on interest, not on MC check (don't ask for data before showing value)
