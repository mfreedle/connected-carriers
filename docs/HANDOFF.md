# Connected Carriers — Project Handoff
**Last updated:** May 19, 2026
**Status:** Full Filter → Confirm → Evaluate → Chase/Signal pipeline operational on canonical data model. Pilot-ready for Kate (Logistics Xpress). Twilio toll-free approved, SMS live.

---

## 1. ARCHITECTURE

The system was rebuilt on May 12-13, 2026 around a spine architecture (see `docs/spines/`). The broker app DB owns all canonical workflow data. MCP remains as a public edge and dispatch verification confirmation handler.

### Data ownership
- **Broker app** (`app.connectedcarriers.org`) owns: `carriers`, `canonical_loads`, `canonical_load_applications`, `load_assignments`, `carrier_profiles`, `carrier_verifications`, `carrier_consents`
- **MCP server** owns: `dispatch_verifications` (arrival check confirmation), legacy `loads`/`load_applications` (deprecated)
- Both services share the same Postgres database via `DATABASE_URL`

### Key services
| Service | URL | Purpose |
|---------|-----|---------|
| Broker app | app.connectedcarriers.org | Dashboard, auth, load management, carrier forms, verification |
| MCP server | cc-mcp-server-production.up.railway.app | Public board (read-only), driver arrival confirmation, MCP tools |
| Marketing site | connectedcarriers.org | Homepage, pricing, about, terms, privacy |

### Key modules
| Module | Path | Purpose |
|--------|------|---------|
| Carrier identity | `app/src/carrier-identity.ts` | `findOrCreateCarrier(mc)` — all paths call this |
| FMCSA lookup | `app/src/lib/fmcsa.ts` | Canonical SAFER parser, one copy |
| Verification service | `app/src/services/verification.ts` | `triggerCarrierVerification()` — no HTTP self-call |
| Dispatch evaluation | `app/src/services/dispatch-evaluation.ts` | `evaluateDispatchPackage()` — insurance waterfall, CDL, cab card, broker thresholds |
| Dispatch signal | `app/src/services/dispatch-signal.ts` | `createDispatchSignal()` — arrival check + SMS |
| Doc parser | `app/src/doc-parser.ts` | OCR via Claude Vision — CDL, insurance, cab card, declarations page |
| Carrier records | `app/src/services/carrier-records.ts` | `syncCanonicalCarrierRecords()` — document storage + supersession |
| Dec page escalation | `app/src/lib/verify-cron.ts` | `runDecPageEscalationCron()` — 15/30/60 min escalation for missing dec pages |
| Canonical loads | `app/src/routes/canonical-loads.ts` | v2 load routes — create, list, applicants, assign, cancel, evaluation API |
| Carrier confirmation | `app/src/routes/carrier-confirm.ts` | `/confirm/:token` — driver/truck confirmation, doc upload, dec page upload |

---

## 2. PILOT STATE

### Kate's credentials
- **Email:** kateloads@logisticsxpress.com
- **Password:** KatePilot2026
- **Forgot password:** SMS code to 310-980-5184
- **Dashboard:** app.connectedcarriers.org/login

### Original pilot load / sample link
- **Load ID:** HX-0513-19EE
- **Link:** app.connectedcarriers.org/l/4C8CC258
- **Route:** Tacoma, WA → Dallas, TX
- **Equipment:** 53' Dry Van
- **Pickup:** May 20, 3401 S Union Ave, Tacoma WA 98409, 6am-10am

### Test MC
- **MC#70000** — SBRUTUS LOGISTICS LLC, Jacksonville FL. Active, authorized.
- Has a dispatch_ready profile in the system from smoke testing.

---

## 3. WHAT WORKS (SMOKE TESTED)

| Step | Status |
|------|--------|
| Kate signs in, dashboard loads | ✅ |
| Kate creates load, gets /l/:slug link | ✅ |
| Carrier applies, FMCSA check, qualified | ✅ |
| Carrier identity resolved via findOrCreateCarrier | ✅ |
| Carrier submits interest, Kate notified via SMS | ✅ |
| Kate sees ranked applicants | ✅ |
| Kate assigns, carrier confirms driver/equipment via `/confirm/:token` | ✅ |
| Dispatch package evaluation returns CLEAR / REVIEW / DO NOT DISPATCH with reasoning | ✅ |
| Insurance waterfall requests declarations page when Scheduled Autos has no VINs | ✅ |
| Dec page non-response escalates at 15/30/60 min | ✅ |
| Kate assigns, missing docs, verification chase (SMS magic link) | ✅ |
| Kate assigns, package CLEAR, dispatch signal (arrival SMS) | ✅ |
| Driver confirms arrival, green, Kate sees On Site | ✅ |
| Driver too far, red, Kate sees Location Alert, later green clears it | ✅ |
| Attention panel shows all states | ✅ |
| SMS consent captured on all carrier paths + broker | ✅ |

---

## 4. SMS COMPLIANCE

| Path | Consent captured | Stored with |
|------|-----------------|-------------|
| Load apply (carrier) | SMS + network reuse | phone, text, IP, UA, load_id |
| Profile form (carrier) | SMS + network reuse | phone, text, IP, UA |
| Verify form /v/:token (carrier) | SMS on first submission | phone, text, IP, UA |
| Broker dashboard (Kate) | One-time banner on first /loads visit | phone, text, IP, UA |

- Twilio toll-free +18449363303 approved
- All carrier SMS identifies Connected Carriers as sender
- All SMS includes Reply STOP to opt out
- Terms page Section 8 covers full SMS policy

---

## 5. SPINE DOCS

See `docs/spines/` for the full architecture:
- SPINE-0001: Broker Load
- SPINE-0002: Carrier Identity
- SPINE-0003: Carrier Profile
- SPINE-0004: Assignment
- SPINE-0005: Verification / Chase
- SPINE-0006: Dispatch Signal
- SPINE-0007: Trust / Ownership / Access

ADRs in `docs/adr/` are aligned with the spine architecture.

---

## 6. INFRASTRUCTURE

| Component | Detail |
|-----------|--------|
| Hosting | Railway (auto-deploy from GitHub main) |
| Database | Postgres on Railway (shared by app + MCP) |
| Storage | Cloudflare R2 |
| SMS | Twilio toll-free +18449363303 |
| DNS | Cloudflare (connectedcarriers.org + sending domains) |
| CRM | Go High Level (agency account + CC sub-account) |
| Repo | github.com/mfreedle/connected-carriers |
| VPS | 137.184.36.72 (Slack listener) |

---

## 7. WHAT'S NOT DONE

| Item | Priority | Notes |
|------|----------|-------|
| Old MCP load routes still active | Low | Redirect for canonical slugs added; old slugs still served by MCP |
| Carrier login / portal | Deferred | MC + magic link flows sufficient for pilot |
| Carrier status page post-submission | Nice to have | Carrier sees thank you but not what's missing |
| Profile freshness cron | Medium | Doc expiration alerts in dashboard, no automated carrier notification |
| Broker-specific carrier notes / blacklist | Future | Needs broker_carrier_notes table |
| Assignment reassignment audit trail | Future | Current model supports supersede but not full history |
