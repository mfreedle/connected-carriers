# Connected Carriers — Project Handoff
**Last updated:** April 12, 2026
**Status:** Directives 1, 2, and 3 complete. Broker dashboard live with full carrier qualification + dispatch clearance workflow.

---

## 1. BRAND ARCHITECTURE (DECIDED)

| Brand | Domain | Role |
|-------|--------|------|
| **HoneXAI** | honexai.com | Parent platform / technology company |
| **Connected Carriers** | connectedcarriers.org (owned) | Consumer-facing carrier network product |
| HONEX | honex.com | Existing site services brand — separate |

---

## 2. INFRASTRUCTURE — CURRENT STATE

### Railway Services
| Service | URL | Status |
|---------|-----|--------|
| Landing page | connected-carriers-production.up.railway.app | Online |
| Postgres | internal / public: crossover.proxy.rlwy.net:22571 | Online |
| MCP server | cc-mcp-server-production.up.railway.app | Online — v1.2.0 |
| Broker dashboard | github-repo-production-2c39.up.railway.app | Online — Directives 1+2+3 |

### Broker Dashboard (deployed April 12)
- URL: https://github-repo-production-2c39.up.railway.app
- Login: kateloads@logisticsxpress.com / password123 (change after first use)
- Root directory in repo: `app/`
- Migrations run automatically on startup
- Seed data: Kate's account + 3 sample carriers

### MCP Server (v1.2.0)
- Tools: `cc_lookup_carrier`, `cc_verify_carrier`, `cc_assign_tier`
- SMS (Twilio): **NOT YET WIRED** — env vars not set in Railway

### VPS Agent Listener
- VPS: `root@137.184.36.72` (SSH key auth)
- Service: `cc_slack_listener` — **RUNNING**
- Listener: `/home/connected-carriers/scripts/slack_listener.py`
- Env file: `/home/connected-carriers/.env`
- Slack channel: `C0ARKBC5VRA` (#cc-agent-logs)
- Fast-path: `CC AGENT — lookup MC<number>` → MCP → posts result in ~3s

### GitHub
- Repo: `github.com/mfreedle/connected-carriers`
- Branch: `main` (auto-deploys to Railway)
- CLAUDE.md: `.claude/CLAUDE.md`

---

## 3. DATABASE SCHEMA

### Original (MCP server)
| Table | Purpose |
|-------|---------|
| `carriers` | Extended with broker fields + onboarding status |
| `carrier_submissions` | Extended with broker fields, FMCSA result, auto-reject |
| `pickup_codes` | 6-digit dispatch fraud prevention codes |
| `dispatch_verifications` | Driver arrival confirmations with GPS |

### Broker dashboard tables
| Table | Purpose |
|-------|---------|
| `broker_accounts` | Broker companies |
| `broker_users` | Users with role (owner/ops/reviewer) |
| `broker_policies` | Per-broker qualification rules |
| `carrier_documents` | COI, W9, agreements, photos |
| `carrier_notes` | Internal notes |
| `activity_logs` | Full audit trail |
| `session` | Express session store |
| `carrier_intake_links` | Token-based intake links (72hr expiry) |
| `dispatch_packets` | Full dispatch clearance workflow per load |

---

## 4. FEATURE STATUS

### Directive 1 — Broker Foundation ✅
- Auth: session-based login/logout
- Dashboard: submission queue with filter tabs + counts
- Carrier detail: FMCSA block, docs, flags, notes, activity timeline
- Decision actions: approve / conditional / reject / more info
- Settings: company profile + all policy toggles

### Directive 2 — Carrier Intake ✅
- Broker generates token-based intake link (72hr)
- Public mobile-friendly form at `/apply/:token`
- FMCSA verification via `cc_verify_carrier` MCP on submit
- Hard-stop auto-reject: inactive MC, MC not found, unsatisfactory safety, authority age, double brokering
- Conditional flags: conditional safety rating, missing W-9/agreement
- Passing submissions land in Kate's queue
- Intake link management at `/intake/links`

### Directive 3 — Dispatch Packet ✅
- "Open Dispatch Packet" from approved/conditional carrier detail
- Single-screen checklist: driver+equipment, insurance reverification, tracking, rate con, pickup
- Gating: all items must pass before "Clear to Roll" activates
- Pickup code: 6-digit generated on clearance when policy requires
- Full activity audit trail
- Dispatch history per carrier at `/carriers/:id/dispatch`

---

## 5. KATE GONZALEZ — FIRST BROKER

- Company: Logistics Xpress
- MC#: 064447
- Email: kateloads@logisticsxpress.com
- Policy: all seeded from her form response (April 7, 2026)
- Key requirements: real-time GPS, $1M auto, 180-day authority minimum, COI at submission

---

## 6. SLACK / AGENT SETUP

- Workspace: connectedcarriers.slack.com
- Bot: CC Agent Dispatcher (A0ARULHN57T)
- Channel: #cc-agent-logs (ID: `C0ARKBC5VRA`) — public via API despite lock icon
- Event subscriptions: `message.channels` AND `message.groups` (both required)
- Directive pattern: `CC AGENT — [directive]`

---

## 7. GOOGLE WORKSPACE

- Domain: connectedcarriers.org
- Email: admin@connectedcarriers.org
- **Trial ends: April 20, 2026 — decide keep or replace**

---

## 8. CARRIER TIERS (BUSINESS DECISIONS — DO NOT CHANGE IN CODE)

| Tier | Criteria |
|------|----------|
| Tier 1 Preferred | In Port TMS + 3+ loads + clean history |
| Tier 2 Approved | New carrier, passes hard stops |
| Tier 3 Conditional | Passes minimums, needs review |
| Rejected | Fails any auto-disqualifier |

---

## 9. DEPLOYMENT & CONFIG STATUS (AS OF APRIL 12, 2026)

### What is deployed to Railway right now
- Directives 1, 2, and 3 are **committed to `main` and auto-deployed** to Railway
- Railway auto-deploys on every push to `main` — no manual deploy step needed
- Migrations run automatically on app startup via `migrate()` chain in `index.ts`
- The Railway service is: `github-repo-production-2c39.up.railway.app`

### Custom domain
- **Status: NOT configured**
- `connectedcarriers.org` is owned and verified in GoDaddy
- Target subdomain: `app.connectedcarriers.org`
- Required steps: add CNAME in GoDaddy DNS pointing to Railway service domain, then add custom domain in Railway service Settings → Networking
- Until done, only `github-repo-production-2c39.up.railway.app` works

### Twilio / SMS
- **Status: NOT wired — SMS does not send**
- Twilio env vars `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_PHONE_NUMBER` are **not set** in Railway
- Pickup codes are generated in the database and displayed in the broker UI on clearance
- Pickup code SMS to driver: **code exists in no file yet** — this is a future build item
- Tracking link SMS to driver: **code exists in no file yet** — tracking status is manually updated by broker in the dispatch packet UI
- To enable SMS: add Twilio env vars to Railway broker app service, then build send functions in dispatch.ts

### Pickup code behavior (current actual state)
- 6-digit code is generated and stored in `dispatch_packets.pickup_code` on clearance
- Code is displayed in the broker UI (clearance banner + packet screen)
- Code is **not sent via SMS** — broker must communicate it manually
- `pickup_codes` table (original MCP server table) is separate and not yet integrated with dispatch packets

## 10. NEXT STEPS (PRIORITY ORDER)

1. **Change Kate's password** — `password123` must be changed before real carrier use
2. **Custom domain** — GoDaddy CNAME `app.connectedcarriers.org` → Railway, then add domain in Railway Settings
3. **Add Twilio env vars to Railway** — `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_PHONE_NUMBER`
4. **Build SMS send functions** — pickup code to driver on clearance, tracking link to driver on dispatch
5. **Deploy automation** — `CC AGENT — migrate` directive via Slack listener (no more manual terminal)
6. **Google Workspace decision** — trial ends April 20, 2026
7. **Security tightening review** — deferred until after FMCSA MCP build

---

## 11. KEY LESSONS / GOTCHAS

- Railway internal hostname unreachable from outside — use public URL for local migrations
- `app.set("trust proxy", 1)` required for secure cookies to work behind Railway proxy
- #cc-agent-logs is public via API despite lock icon — needs `message.channels` event subscription
- Claude's Slack tool = Signature Fencing workspace, NOT Connected Carriers
- Broker dashboard root directory in Railway is `app/` (not repo root)
- Migrations run automatically on startup — no manual step needed after deploy
- `railway run` must be executed from the repo's `app/` directory, not from any other folder

---

## 12. PRODUCT ROADMAP

```
Layer 1 (NOW):  Carrier qualification portal — Directives 1+2+3 complete
Layer 2 (NEXT): Performance memory per carrier per load
Layer 3:        Network intelligence across multiple brokers
Layer 4:        Load marketplace for pre-screened carriers
```
