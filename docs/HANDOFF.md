# Connected Carriers — Project Handoff
**Last updated:** April 13, 2026
**Status:** Full three-layer MVP wired — Arrival Check + Auto-Chase + Carrier Profile flywheel. Waiting on Twilio A2P approval (5-7 days) for SMS delivery. All backend logic deployed and ready.

---

## 1. PRODUCT STATUS — HONEST ASSESSMENT

| Stage | Status |
|-------|--------|
| Internal demo ready | ✅ Yes |
| Controlled pilot ready | ⏳ Pending Twilio A2P approval — all code deployed, SMS blocked by trial/verification |
| Production ready | ❌ No — Twilio pending, security not fully tightened, needs real-load testing |

The broker dashboard exists and the full qualification → dispatch workflow is functional. It is not hardened for daily real-world use yet. The description "full workflow" is aspirational — more accurately: **functional MVP workflow with known gaps documented below**.

---

## 2. BRAND ARCHITECTURE (DECIDED)

| Brand | Domain | Role |
|-------|--------|------|
| **HoneXAI** | honexai.com | Parent platform / technology company |
| **Connected Carriers** | connectedcarriers.org (owned) | Consumer-facing carrier network product |
| HONEX | honex.com | Existing site services brand — separate |

---

## 3. INFRASTRUCTURE — CURRENT STATE

### Railway Services
| Service | URL | Status |
|---------|-----|--------|
| Landing page | connected-carriers-production.up.railway.app | Online — dispatch verification wedge live |
| Postgres | internal / public: crossover.proxy.rlwy.net:22571 | Online |
| MCP server | cc-mcp-server-production.up.railway.app | Online — v1.2.0 |
| Broker dashboard | github-repo-production-2c39.up.railway.app | Online — MVP |
| Broker dashboard (custom) | app.connectedcarriers.org | Online ✅ |
| R2 storage | connected-carriers-docs (Cloudflare) | Configured ✅ |

### Broker Dashboard
- Login: kateloads@logisticsxpress.com — production DB was seeded before hardening pass; password123 is still the active credential until manually rotated. seed.ts no longer emits password123 for new deploys.
- Root directory in repo: `app/`
- Migrations run automatically on startup — no manual step needed after deploy
- Railway auto-deploys on every push to `main`

### MCP Server (v1.2.0)
- Tools: `cc_lookup_carrier`, `cc_verify_carrier`, `cc_assign_tier`
- SMS (Twilio): **Env vars set on MCP server** — waiting on Twilio A2P approval
- Twilio account status: Trial → upgrade in progress, toll-free verification pending (5-7 days)
- Auto-chase nudge timer: runs every 2 minutes, sends driver reminders at 10-min intervals (max 2)
- No-confirmation broker alert: fires 15 min before pickup window if no driver confirmation
- Geofence bounce: drivers outside 2 miles get bounced with retry message
- GPS required: drivers who deny location permission get bounced
- Early arrival detection: flags confirmations >30 min before window
- Supersede logic: new arrival check for same pickup auto-supersedes old one, notifies old driver

### VPS Agent Listener
- VPS: `root@137.184.36.72` (SSH key auth)
- Service: `cc_slack_listener` — **RUNNING**
- Listener: `/home/connected-carriers/scripts/slack_listener.py`
- Env file: `/home/connected-carriers/.env`
- Slack channel: `C0ARKBC5VRA` (#cc-agent-logs)
- Fast-path: `CC AGENT — lookup MC<number>` → MCP → result in ~3s

### GitHub
- Repo: `github.com/mfreedle/connected-carriers`
- Branch: `main` (auto-deploys to Railway)
- CLAUDE.md: `.claude/CLAUDE.md`

---

## 4. CANONICAL ARCHITECTURE — WHICH OBJECTS WIN

This is the authoritative decision on overlapping concepts. Do not leave this ambiguous.

### dispatch_packets — canonical operational object ✅
`dispatch_packets` is the real dispatch workflow going forward. It owns:
- driver + equipment data
- insurance reverification
- tracking status
- rate confirmation
- pickup appointment
- clearance status + cleared_by + cleared_at
- pickup code (inline field)

### dispatch_verifications — legacy / narrower scope ⚠
`dispatch_verifications` was built for the MCP-layer driver arrival geofence confirmation (GPS lat/lng, geofence radius, driver SMS token). It is a different and narrower concept than a full dispatch packet. It is **not deprecated** but it is **not the operational dispatch workflow** — that is `dispatch_packets`. If geofence confirmation is built in a future directive, it should attach to `dispatch_packets` via a foreign key rather than operate independently.

### pickup_codes (original table) — DEPRECATED ✅ DECIDED
**Decision: Option A — `dispatch_packets.pickup_code` is canonical. `pickup_codes` table is deprecated.**

Rationale: The `pickup_codes` table has no data, no FK references from any broker-layer table, and no code that reads or writes it in the broker app. It was designed for a future SMS flow that was never built. Building it now is premature. The inline `dispatch_packets.pickup_code` pattern is correct for the current MVP.

Current pickup code implementation (post-hardening):
- Generated with `crypto.randomInt(100000, 999999)` — cryptographically secure
- Plaintext stored in `dispatch_packets.pickup_code` for broker UI display (internal broker-only surface)
- Hash stored in `dispatch_packets.pickup_code_hash` (SHA-256)
- Retained in broker-internal UI after clearance (plaintext in dispatch_packets.pickup_code); hash also stored in pickup_code_hash for future verification path — not sent externally
- Not sent externally — SMS requires Twilio (not yet wired)

If/when SMS is wired: send the plaintext at generation time, then rely on the hash for verification. At that point, evaluate whether to drop the plaintext column.

The `pickup_codes` table in the MCP server schema is inert. It should be marked deprecated in a future MCP server migration.

---

## 4B. DISPATCH VERIFICATION — ARRIVAL CHECK MVP

### Product positioning (decided April 13, 2026)
The primary broker-facing wedge is **Dispatch Verification / Arrival Check** — not the full qualification platform. The homepage hero and all primary CTAs route to `dispatch.html`. The qualification workflow (setup packets, carrier review, dispatch packets) remains as the deeper platform, but the arrival check is what brokers try first.

**Copy principles (locked in):**
- We say: "flags change at pickup" / "gives broker a signal before release"
- We do NOT say: "prevents fraud" / "verifies identity" / "guarantees correct driver"
- Product line: "We don't track the truck — we verify the moment it shows up."

### Geofence design (decided — updated April 13)
The geofence is a **gate**, not just a classifier. Drivers outside the geofence cannot confirm arrival — they get bounced with a retry message. The confirmation only fires when the driver is physically near the pickup.

**Zones:**
| Zone | Distance | Behavior |
|------|----------|----------|
| Green | Within 1 mile | Confirmation accepted. Broker notified: ON SITE. |
| Yellow | 1–2 miles | Confirmation accepted. Broker notified: NEAR — review before loading. |
| Red | 2+ miles | **Bounced.** Driver sees "You're not at the pickup yet. Tap again when you arrive." Token stays active. |
| No GPS | — | **Bounced.** Driver sees "Location required. Please allow location and try again." |

**Signals evaluated:**
1. **Distance from pickup** — GPS at confirmation vs geocoded pickup address
2. **Timing vs pickup window** — confirmation timestamp vs expected window
3. **Early arrival** — confirmations >2hr early = "very_early" flag, >30min early = "early" note in broker SMS

**What the geofence does NOT do:**
- Prove driver identity
- Prevent fraud
- Enforce anything — it surfaces inconsistency at the moment of risk

### Pickup code + geofence interaction (future)
The pickup code should only unlock when the driver's phone is within the geofence (1–2 mile radius). This is a V2 feature — not part of the current arrival check MVP. The arrival check is the low-friction wedge; the pickup code is a higher-commitment workflow that requires shipper/dock participation.

### Internal phone-flow logging (decided — do not surface yet)
When the driver taps the SMS confirmation link, the system should quietly log session metadata (user agent, IP, device fingerprint) alongside the confirmation record. This creates a technical distinction between:
- **Direct flow** — confirmation came from the same device/session that received the SMS
- **Indirect flow** — link was forwarded to a different device before confirmation

**This is logged internally only. It is NOT surfaced in the broker UI or marketing copy for MVP.** Reasons:
- Carriers share phones, dispatch offices forward links, drivers use tablets — legitimate indirect flows are common
- Surfacing it prematurely creates false flags that erode broker trust in the signal
- After ~50 verifications, review the data to see if indirect flow correlates with actual problems before deciding whether to surface it

When ready (V2+), this data supports an identity consistency signal without requiring any additional driver input.

### Dispatch verification flow (current — full SMS sequence)
```
T+0:     Broker fills form on dispatch.html
         → System geocodes, generates token, stores pickup lat/lng + window
         → SMS to driver: "[Load ID] — pickup at [address]. Confirm arrival. Time-sensitive."
         → If replacing an existing pending verification for same pickup: old one superseded,
           old driver notified: "Load reassigned. Complete your carrier profile for faster clearance."

T+10min: If no confirmation → Nudge 1 to driver: "Reminder — please confirm when you arrive."

T+20min: If still no confirmation → Nudge 2 to driver: "Still waiting — load may move to another carrier."
         → Broker alerted: "No response from driver — two reminders sent."

Window-15min: If still pending → Broker alert: "⛔ No arrival confirmation. HOLD / CALL DRIVER."

On confirm (green):  → Broker SMS: "Confirmed ✓ — [dist] from pickup. ON SITE."
On confirm (yellow): → Broker SMS: "Nearby — [dist] from pickup. NEAR — confirm before loading."
On confirm (early):  → Broker SMS includes: "⚠ Confirmed before pickup window."
Driver too far:      → Driver bounced: "Not at pickup yet. Tap again when you arrive."
Driver no GPS:       → Driver bounced: "Location required. Allow location and try again."
Driver superseded:   → Driver sees: "Load reassigned — no action needed." + profile CTA
```

### Auto-chase nudge system (built — April 13)
Based on Kate's feedback: she follows up within 10 minutes, chases twice, then moves on.
- Timer runs every 2 minutes on MCP server
- Checks all pending dispatch_verifications
- Nudge 1 at T+10min, Nudge 2 at T+20min, then stops
- After Nudge 2: broker gets "driver unresponsive" alert
- No-confirmation alert fires 15 min before pickup window opens
- `reminder_count`, `last_reminder_at`, `no_confirm_alert_sent` columns track state

### Supersede + carrier profile flywheel (built — April 13)
When a broker reassigns a load (sends new arrival check for same pickup):
1. Old verification marked `status = 'superseded'`
2. Old driver gets SMS: "Load reassigned. Complete your carrier profile for faster clearance next time."
3. Old driver's verify link shows "Load reassigned" page with profile CTA
4. `/carrier-profile` on MCP server redirects to `app.connectedcarriers.org/profile/carrier?source=superseded_nudge`
5. Carrier profile page collects all docs Kate needs (CDL, VIN photo, insurance, driver/truck details)
6. Complete profiles = dispatch-ready carriers = no doc chase on next load

Auto-detect: same broker_phone + same pickup_address = supersedes old pending verification
Explicit: `replaces_load_id` param in POST /dispatch

### Carrier profile page (built — April 13)
- Route: `GET/POST /profile/carrier` on broker dashboard (app.connectedcarriers.org)
- Collects: company info, MC, driver name/phone, truck/trailer numbers
- Uploads: CDL photo, VIN photo, insurance certificate (R2 storage)
- Completion tracking: `partial` vs `dispatch_ready`
- Source tracking: `direct` / `superseded_nudge` / `broker_invite` / `interest_upgrade`
- Superseded carriers see urgency banner: "Your last load was assigned to another carrier because docs weren't ready in time."
- DB table: `carrier_profiles` with indexes on mc_number, email, completion_status

---

## 5. RECORD LIFECYCLE

A carrier moves through Connected Carriers in this sequence:

```
broker generates carrier_intake_link (token, 72hr expiry)
    ↓
carrier submits intake form at /apply/:token
    ↓
FMCSA verification runs via cc_verify_carrier MCP
    ↓
hard-stop check → auto-rejected? → recorded in carrier_submissions (status: rejected, auto_rejected: true)
    ↓
conditional flags? → lands in queue (status: conditional) → Kate reviews
    ↓
passes all checks → lands in queue (status: submitted) → Kate reviews
    ↓
Kate makes decision: approve / conditional / reject / more_info
    → updates carrier.onboarding_status + carrier.approval_tier
    → writes activity_log
    ↓
approved or conditional carrier → Kate opens dispatch packet
    ↓
dispatch_packet checklist: driver + equipment, insurance reverification,
tracking acceptance, rate confirmation, pickup appointment
    ↓
all gates pass → Kate clicks "Clear to Roll"
    → dispatch_packet.final_clearance_status = 'cleared_to_roll'
    → pickup code generated if policy.pickup_code_required = true
    → activity_log written
    ↓
[future] pickup code sent to driver via SMS (Twilio — not yet wired)
[future] tracking link sent to driver via SMS (Twilio — not yet wired)
```

---

## 6. ROUTE INVENTORY

### Broker (auth required)
| Method | Route | Purpose |
|--------|-------|---------|
| GET | `/login` | Login page |
| POST | `/login` | Authenticate |
| POST | `/logout` | Sign out |
| GET | `/dashboard` | Submission queue with filter tabs |
| GET | `/carriers/:id` | Carrier detail + review screen |
| POST | `/carriers/:id/decision` | Approve / conditional / reject / more_info |
| POST | `/carriers/:id/notes` | Add internal note |
| GET | `/settings` | Company profile + policy toggles |
| POST | `/settings` | Save settings |
| POST | `/intake/create` | Generate intake link |
| GET | `/intake/links` | List all intake links |
| POST | `/intake/links/:id/cancel` | Cancel intake link |
| POST | `/carriers/:id/dispatch/create` | Open dispatch packet |
| GET | `/dispatch/:id` | Dispatch packet detail + checklist |
| POST | `/dispatch/:id/driver` | Save driver & equipment |
| POST | `/dispatch/:id/insurance` | Save insurance reverification |
| POST | `/dispatch/:id/tracking/send` | Mark tracking link sent |
| POST | `/dispatch/:id/tracking/accept` | Mark tracking accepted |
| POST | `/dispatch/:id/tracking/reject` | Mark tracking rejected |
| POST | `/dispatch/:id/rate-confirm` | Mark rate confirmation signed |
| POST | `/dispatch/:id/pickup-confirm` | Confirm pickup appointment |
| POST | `/dispatch/:id/clear` | Clear to Roll (gated) |
| POST | `/dispatch/:id/cancel` | Cancel dispatch packet |
| GET | `/carriers/:id/dispatch` | Dispatch history for carrier |

### Public (no auth)
| Method | Route | Purpose |
|--------|-------|---------|
| GET | `/apply/:token` | Carrier intake form |
| POST | `/apply/:token` | Submit intake form |

---

## 7. SECURITY STATUS

| Item | Status |
|------|--------|
| Default credentials | ✅ Fixed — seed.ts uses SEED_PASSWORD env var or crypto random in production; password123 eliminated |
| SESSION_SECRET | ✅ Fixed — app exits on boot in production if SESSION_SECRET not set; no plaintext fallback |
| Stored XSS | ✅ Fixed — `h()` escapeHtml() applied to all user-supplied fields across all broker templates |
| Pickup code generation | ✅ Fixed — `crypto.randomInt()` replaces `Math.random()` |
| Pickup code storage | ✅ Fixed — SHA-256 hash stored in `pickup_code_hash`; plaintext retained for broker-internal UI display only |
| CSRF protection | ✅ Fixed — session double-submit token on all broker POST routes; public intake form exempt |
| Settings role gate | ✅ Fixed — POST /settings requires `requireOwner`; reviewer/ops roles cannot mutate policy |
| Intake rate limiting | ✅ Fixed — max 3 submission attempts per token; DB-backed; blocks FMCSA hammering |
| /setup route | ✅ Fixed — gated to NODE_ENV !== production; inaccessible on Railway |
| Custom domain | ❌ Not configured — Railway URL only |
| HTTPS | ✅ Railway provides HTTPS automatically |
| Session cookies | ✅ Secure + httpOnly + trust proxy set |
| Twilio / SMS | ❌ Not configured — no SMS sends at all |
| Token-based intake links | ✅ 32-byte crypto random tokens |
| GitHub token in docs | ✅ Scrubbed |
| Trust boundary | App trusts Railway proxy (correct). No public-facing admin routes. Intake form is public but token-gated and rate-limited. |

---

## 8. DEPLOYMENT & CONFIG STATUS

### What is deployed right now
- Directives 1, 2, and 3 are committed to `main` and auto-deployed to Railway
- All three migrations (`migrate`, `migrateIntake`, `migrateDispatch`) run on startup
- Seed data loaded: Kate's account, 3 sample carriers

### Custom domain
- **NOT configured**
- Target: `app.connectedcarriers.org`
- Steps: GoDaddy → add CNAME pointing to `github-repo-production-2c39.up.railway.app` → Railway service Settings → Networking → add custom domain

### Twilio / SMS
- **CONFIGURED ✅** — env vars set in Railway GitHub Repo service
- Pickup code SMS: sent to driver on clearance when `pickup_code_required=true` and `driver_phone` present
- Tracking link SMS: sent to driver when broker clicks "Send tracking link + SMS"
- Failure handling: SMS failure never blocks dispatch workflow — broker UI shows delivery status
- Public tracking page: `GET /track/:token` — driver accepts/rejects tracking from phone

---

## 9. KATE GONZALEZ — FIRST BROKER

- Company: Logistics Xpress
- MC#: 064447
- Email: kateloads@logisticsxpress.com
- Policy seeded from her form response (April 7, 2026):
  - $1M auto / $100K cargo / $1M general liability
  - 180-day minimum authority age
  - COI required at submission, auto-reject expired COI
  - Real-time GPS required, double brokering → auto-reject
  - Rate confirmation, driver phone, truck+trailer number, dispatch packet all required

### Kate's feedback (April 13, 2026 — text responses)
**Q1: How do you know the right driver showed up?**
"We send carrier name, driver name, phone number, copy of CDL, photo of VIN on truck, truck number, trailer number. SHIPPER is supposed to confirm everything matches. SUPPOSED to. One of Joe's tire loads was stolen because the shipper did not confirm the VIN number..."

**Q2: How often does something change between dispatch and pickup?**
"5%? More with spot loads than contract loads."

**Q3: Biggest headache between clearing a carrier and the load moving?**
"Communicating with dispatch to get required docs/photos and contacting insurance to confirm coverage or VIN number that is provided."

### What Kate's feedback tells us
- The pickup verification gap is real — Joe's tires story validates the arrival check
- 5% change rate, higher on spot loads — spot loads = highest value for the tool
- Daily pain is **chasing docs and insurance** — auto-chase nudge system directly addresses this
- She follows up within **10 minutes**, chases **twice**, then moves on to another carrier
- She runs **multiple carriers in parallel** on the same load — supersede logic handles this

---

## 10. SLACK / AGENT SETUP

- Workspace: connectedcarriers.slack.com
- Bot: CC Agent Dispatcher (A0ARULHN57T)
- Channel: #cc-agent-logs (ID: `C0ARKBC5VRA`) — public via API despite lock icon
- Event subscriptions required: `message.channels` AND `message.groups`
- Directive pattern: `CC AGENT — [directive]`
- Claude's Slack tool = Signature Fencing workspace — never use it for CC channel IDs

---

## 11. NEXT STEPS (PRIORITY ORDER)

### Completed April 13, 2026 ✅
1. ~~Homepage CTA routing~~ — all primary CTAs → dispatch.html, interest forms secondary
2. ~~Dispatch.html copy tightened~~ — honest framing, no overclaiming
3. ~~Geofence threshold~~ — 1mi green / 2mi yellow / 2+ red (was 0.5/2.0)
4. ~~Geofence bounce logic~~ — driver can't confirm from >2 miles, gets retry message
5. ~~GPS required~~ — drivers who deny location get bounced
6. ~~Early arrival detection~~ — flags confirmations before pickup window in broker SMS
7. ~~Auto-chase nudge system~~ — 10-min cadence, 2 nudges max, broker alert on no response
8. ~~No-confirmation alert~~ — broker gets "HOLD / CALL DRIVER" 15 min before window
9. ~~Supersede logic~~ — new arrival check auto-supersedes old one, old driver notified
10. ~~Carrier profile page~~ — `/profile/carrier` with doc uploads (CDL, VIN, insurance)
11. ~~Carrier profile flywheel~~ — superseded carriers nudged to complete profile for next dispatch
12. ~~Twilio env vars~~ — added to MCP server Railway service
13. ~~Interest form links fixed~~ — all were using relative paths, now absolute
14. ~~Stale Google Form link~~ — dispatch.html footer was pointing to old form, fixed
15. ~~HANDOFF.md updated~~ — full design decisions documented

### Blocked — waiting on Twilio
- **Twilio A2P approval** — account upgrade in progress, toll-free verification pending (5-7 days)
- Once live: end-to-end test with real phone numbers
- Once tested: Kate tries arrival check on a real load

### After Kate's pilot
- **Homepage messaging update** — lead with whichever of the three layers Kate values most
- **Dispatch Readiness board** — prototype built (React), deploy after signals are validated
- **Setup packet nudge SMS** — auto-remind carriers who haven't completed docs (uses same Twilio)
- **COI expiry alerts** — cron job, SMS to broker when carrier COI approaching expiration

### Remaining technical debt
- Deploy automation — `CC AGENT — migrate` from Slack
- dispatch_verifications → dispatch_packets link — add FK when workflows merge
- Setup packet rate limiting — `/setup/:token/doc/:type` not yet rate-limited
- Carrier-side activity logging — doc uploads not yet in activity_logs
- Security tightening review — deferred, needs dedicated block

### Business
- **Google Workspace decision** — trial ends April 20, 2026
- **Kate pilot** — text her the dispatch.html link when Twilio is live

---

## 12. CARRIER TIERS (BUSINESS DECISIONS — DO NOT CHANGE IN CODE)

| Tier | Criteria |
|------|----------|
| Tier 1 Preferred | In Port TMS + 3+ loads + clean history |
| Tier 2 Approved | New carrier, passes hard stops |
| Tier 3 Conditional | Passes minimums, needs review |
| Rejected | Fails any auto-disqualifier |

---

## 13. KEY LESSONS / GOTCHAS

- Railway internal hostname unreachable from outside — use public URL for local DB work
- `app.set("trust proxy", 1)` required for secure cookies behind Railway proxy
- #cc-agent-logs reports as public via API despite lock icon — needs `message.channels` event subscription
- Claude's Slack tool = Signature Fencing workspace, NOT Connected Carriers
- Broker dashboard root directory in Railway is `app/` not repo root
- `railway run` must be executed from `app/` directory with public DATABASE_URL
- `dispatch_verifications` and `pickup_codes` are MCP-layer tables — do not confuse with broker-layer `dispatch_packets`
- `connectedcarriers.org` root domain DNS points to GoDaddy forwarding (AWS Global Accelerator IPs), NOT directly to Railway — all cross-page links from index.html must use absolute URLs to the Railway service or `app.connectedcarriers.org`; relative links break because the forwarding layer doesn't serve the files directly
- `app.connectedcarriers.org` is correctly CNAME'd to Railway — no forwarding issues there
- All primary broker CTAs on index.html now route to `dispatch.html` (dispatch verification wedge); interest forms preserved as secondary links
- Twilio trial accounts only send to verified numbers — must upgrade for real SMS delivery
- Twilio env vars must be set on BOTH the broker dashboard service AND the MCP server service — they're separate Railway services

---

## 14. PRODUCT ROADMAP

```
Layer 1 (BUILT):  Arrival check — geofence gate, GPS required, bounce logic, broker SMS alerts
Layer 1B (BUILT): Auto-chase — 10-min nudges, 2 max, broker "no response" alert
Layer 1C (BUILT): Supersede + carrier profile flywheel — reassignment handling, profile self-service
Layer 2 (NEXT):   Kate pilot — real loads, real SMS, real feedback
Layer 3:          Dispatch Readiness board — three-tab broker control screen (prototyped)
Layer 4:          Setup packet auto-chase SMS — carrier doc reminders at 10-min cadence
Layer 5:          Pickup code as dock-side authorization (requires shipper participation)
Layer 6:          Performance memory per carrier per load
Layer 7:          Network intelligence across multiple brokers
Layer 8:          Load marketplace for pre-screened carriers
```

### Three-layer product framing (decided)
1. **Inbound Filter** — "Is this carrier worth my time?" (FMCSA check, instant signal)
2. **Auto-Chase** — "Stop me from chasing docs." (10-min nudge cadence, 2 max, then move on)
3. **Arrival Check** — "Did something change at the dock?" (geofence gate, timing, broker alert)

Product line: **"We filter inbound carriers, chase their docs, and alert you if anything changes at pickup."**
