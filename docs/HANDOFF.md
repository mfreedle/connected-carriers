# Connected Carriers — Project Handoff
**Last updated:** April 13, 2026
**Status:** Functional MVP live. Dispatch verification wedge deployed — arrival check via SMS + geofence is the primary broker-facing action. Full qualification workflow also operational.

---

## 1. PRODUCT STATUS — HONEST ASSESSMENT

| Stage | Status |
|-------|--------|
| Internal demo ready | ✅ Yes |
| Controlled pilot ready | ✅ Yes — custom domain live, Twilio wired, SMS delivery active |
| Production ready | ❌ No — SMS not wired, security not tightened, manual steps remain |

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
- SMS (Twilio): **NOT wired**

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

### Geofence design (decided)
The geofence is a **classification signal**, not an enforcement boundary. It answers: "Did the driver confirm arrival near the expected place, at the expected time?"

**Zones:**
| Zone | Distance | Meaning |
|------|----------|---------|
| Green | Within 1 mile | Arrival confirmed near pickup. No action needed. |
| Yellow | 1–2 miles | Something looks different. Review before release. |
| Red | 2+ miles | Something changed. Do not release — call carrier. |

**Signals evaluated:**
1. **Distance from pickup** — GPS at confirmation vs geocoded pickup address
2. **Timing vs pickup window** — confirmation timestamp vs expected window

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

### Dispatch verification flow (current)
```
Broker fills form on dispatch.html (driver phone, broker phone, pickup address, window, optional MC)
    ↓
System geocodes address, generates token, stores pickup lat/lng + window
    ↓
SMS sent to driver with confirmation link
    ↓
Driver taps link at pickup → browser captures GPS + timestamp
    ↓
System evaluates: distance from pickup + timing vs window
    ↓
Broker receives SMS alert: green / yellow / red signal
    ↓
Record stored: timestamp, GPS, distance, geofence status, FMCSA context if MC provided
```

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

### Completed this session ✅
1. ~~Custom domain~~ — `app.connectedcarriers.org` live
2. ~~R2 storage~~ — Cloudflare R2 configured
3. ~~Twilio SMS~~ — pickup code + tracking link delivery wired
4. ~~Carrier setup packet~~ — full compliance doc workflow
5. ~~First-party interest forms~~ — `/interest/broker` + `/interest/carrier`
6. ~~Landing page footer~~ — all dead links fixed, 6 anchor sections added
7. ~~Standalone pages~~ — `/about`, `/privacy`, `/terms`, `/contact`
8. ~~Hero copy~~ — broker-first positioning
9. ~~Private beta indicator~~ — hero + about page

### Immediate (before real broker use)
2. **Run migrations on live DB** — `pickup_code_hash` column must be added to production (runs automatically on next deploy restart)

### Technical debt (resolved this session)
- ~~Default credentials~~ — fixed
- ~~SESSION_SECRET fallback~~ — fixed
- ~~XSS escaping~~ — fixed
- ~~Math.random() pickup codes~~ — fixed
- ~~Pickup code not hashed~~ — fixed
- ~~No CSRF protection~~ — fixed
- ~~Settings not role-gated~~ — fixed
- ~~Intake rate limiting~~ — fixed
- ~~/setup exposed in production~~ — fixed
- ~~pickup_codes architecture ambiguity~~ — decided (deprecated, dispatch_packets canonical)

### Remaining technical debt
3. **Deploy automation** — `CC AGENT — migrate` from Slack so no manual terminal needed
4. **dispatch_verifications → dispatch_packets link** — add FK when geofence feature is built
5. **Setup packet: rate limiting** — public `/setup/:token/doc/:type` not yet rate-limited (low risk due to tokenization but worth adding)
6. **Setup packet: carrier-side activity logging** — doc uploads and company info updates not yet logged in activity_logs
7. **Setup packet: phone required** — completion check now requires phone; existing seeded packets may show company info as incomplete until carrier resubmits
8. **COI expiry reminders** — no automated email when COI is approaching expiry; broker must monitor manually for now
9. **Landing page footer** — dead `#` links in Network/Platform/Company columns need cleanup

### Infrastructure
5. **Add Twilio env vars to Railway** — then build SMS send in `dispatch.ts`
6. **Security tightening review** — deferred from earlier session, needs its own block of time

### Business
7. **Google Workspace decision** — trial ends April 20, 2026

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

---

## 14. PRODUCT ROADMAP

```
Layer 1 (NOW):  Dispatch verification / arrival check — broker-facing MVP wedge live
Layer 1B:       Carrier qualification + dispatch clearance — functional MVP complete
Layer 2 (NEXT): Geofence backend hardening, pickup code unlock at geofence, phone-flow logging
Layer 3:        Pickup code as dock-side authorization (requires shipper participation)
Layer 4:        Performance memory per carrier per load
Layer 5:        Network intelligence across multiple brokers
Layer 6:        Load marketplace for pre-screened carriers
```
