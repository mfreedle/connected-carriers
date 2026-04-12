# Connected Carriers — Project Handoff
**Last updated:** April 12, 2026
**Status:** Functional MVP live. Directives 1, 2, 3 complete. Not yet production-hardened.

---

## 1. PRODUCT STATUS — HONEST ASSESSMENT

| Stage | Status |
|-------|--------|
| Internal demo ready | ✅ Yes |
| Controlled pilot ready | ⚠ Nearly — requires password change + custom domain |
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
| Landing page | connected-carriers-production.up.railway.app | Online |
| Postgres | internal / public: crossover.proxy.rlwy.net:22571 | Online |
| MCP server | cc-mcp-server-production.up.railway.app | Online — v1.2.0 |
| Broker dashboard | github-repo-production-2c39.up.railway.app | Online — MVP |

### Broker Dashboard
- Login: kateloads@logisticsxpress.com / **password123** (⚠ must change before real use)
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

### pickup_codes (original table) — legacy, to be reconciled ⚠
The original `pickup_codes` table was built for the MCP server's SMS-based pickup code flow. Currently:
- Pickup codes for the broker dispatch workflow are stored inline on `dispatch_packets.pickup_code`
- The original `pickup_codes` table is not integrated with `dispatch_packets`
- These are two disconnected concepts carrying the same intent

**Decision needed (next session):** Either integrate `pickup_codes` into `dispatch_packets` (add `pickup_code_id FK`) or deprecate `pickup_codes` and treat `dispatch_packets.pickup_code` as canonical. Until decided, both exist and the `pickup_codes` table is effectively dormant in the broker workflow.

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
| Default credentials in DB | ⚠ **YES** — kateloads@logisticsxpress.com / password123 must be changed |
| Custom domain | ❌ Not configured — Railway URL only |
| HTTPS | ✅ Railway provides HTTPS automatically |
| Session cookies | ✅ Secure + httpOnly + trust proxy set |
| Twilio / SMS | ❌ Not configured — no SMS sends at all |
| Pickup codes | ⚠ UI-display only — not sent to driver, not hashed |
| Token-based intake links | ✅ 32-byte crypto random tokens |
| GitHub token in docs | ✅ Scrubbed from HANDOFF and Slack canvas |
| Security tightening review | ❌ Intentionally deferred — scheduled post-FMCSA build |
| Trust boundary | App trusts Railway proxy (correct). No public-facing admin routes. Carrier intake form is public but token-gated. |

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
- **NOT configured — no SMS sends**
- Env vars not set: `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_PHONE_NUMBER`
- Pickup code: generated in DB, shown in broker UI, not sent to driver
- Tracking link: status tracked manually in dispatch UI, not sent to driver
- To enable: add env vars in Railway → build send functions in `dispatch.ts`

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

### Immediate (before real broker use)
1. **Change Kate's password** — password123 is seeded default, must change before pilot
2. **Custom domain** — `app.connectedcarriers.org` (GoDaddy CNAME + Railway)

### Technical debt (scheduled next session)
3. **Schema cleanup: dispatch + pickup code architecture** — decide: integrate `pickup_codes` table with `dispatch_packets` or deprecate it; decide: is `dispatch_verifications` still needed or does it attach to `dispatch_packets`
4. **Deploy automation** — `CC AGENT — migrate` from Slack so no manual terminal needed

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

---

## 14. PRODUCT ROADMAP

```
Layer 1 (NOW):  Carrier qualification + dispatch clearance — functional MVP complete
Layer 2 (NEXT): SMS wiring, schema cleanup, security hardening → pilot ready
Layer 3:        Performance memory per carrier per load
Layer 4:        Network intelligence across multiple brokers
Layer 5:        Load marketplace for pre-screened carriers
```
