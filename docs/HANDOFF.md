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

## 9. NEXT STEPS (PRIORITY ORDER)

1. **Custom domain** — point `app.connectedcarriers.org` → broker dashboard (GoDaddy DNS + Railway)
2. **Add Twilio env vars to Railway** — `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_PHONE_NUMBER`
3. **Deploy automation** — `CC AGENT — migrate` directive via Slack listener (no more manual terminal)
4. **Change Kate's password** — default password123 must be changed before real use
5. **Google Workspace decision** — April 20 deadline
6. **Security tightening review** — per checklist deferred from earlier session

---

## 10. KEY LESSONS / GOTCHAS

- Railway internal hostname unreachable from outside — use public URL for local migrations
- `app.set("trust proxy", 1)` required for secure cookies to work behind Railway proxy
- #cc-agent-logs is public via API despite lock icon — needs `message.channels` event subscription
- Claude's Slack tool = Signature Fencing workspace, NOT Connected Carriers
- Broker dashboard root directory in Railway is `app/` (not repo root)
- Migrations run automatically on startup — no manual step needed after deploy
- `railway run` must be executed from the repo's `app/` directory, not from any other folder

---

## 11. PRODUCT ROADMAP

```
Layer 1 (NOW):  Carrier qualification portal — Directives 1+2+3 complete
Layer 2 (NEXT): Performance memory per carrier per load
Layer 3:        Network intelligence across multiple brokers
Layer 4:        Load marketplace for pre-screened carriers
```
