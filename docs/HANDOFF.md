# Connected Carriers — Project Handoff
**Last updated:** April 12, 2026
**Status:** Broker dashboard live. MCP server v1.2.0 live. Slack listener active with MC lookup fast-path.

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
| Postgres | internal | Online |
| MCP server | cc-mcp-server-production.up.railway.app | Online — v1.2.0 |
| Broker dashboard | github-repo-production-2c39.up.railway.app | Online — Directive 1 |

### Broker Dashboard (Directive 1 — deployed April 12)
- URL: https://github-repo-production-2c39.up.railway.app
- Login: kateloads@logisticsxpress.com / password123 (change after first use)
- Root directory: `app/` in repo
- Features: submission queue, carrier detail, decision actions, notes, activity log, settings
- Migrations run, seed data loaded (Kate's account + 3 sample carriers)

### MCP Server (v1.2.0 — deployed April 12)
- Health: `GET https://cc-mcp-server-production.up.railway.app/health`
- Tools: `cc_lookup_carrier`, `cc_verify_carrier`, `cc_assign_tier`
- `/mcp` endpoint: **FIXED** — per-request McpServer factory pattern
- Geocoding: working via Nominatim fallback
- SMS (Twilio): **NOT YET WIRED** — env vars not set in Railway

### VPS Agent Listener
- VPS: `root@137.184.36.72` (DigitalOcean, SSH key auth)
- Service: `cc_slack_listener` — **RUNNING**
- Listener: `/home/connected-carriers/scripts/slack_listener.py`
- Env file: `/home/connected-carriers/.env`
- Slack channel: `C0ARKBC5VRA` (#cc-agent-logs)
- Fast-path: `CC AGENT — lookup MC<number>` → hits MCP, posts result in ~3s

### GitHub
- Repo: `github.com/mfreedle/connected-carriers`
- Branch: `main` (auto-deploys to Railway)
- CLAUDE.md: `.claude/CLAUDE.md`

---

## 3. DATABASE SCHEMA (Postgres on Railway)

### Original tables (MCP server)
| Table | Purpose |
|-------|---------|
| `carriers` | Extended — now has broker fields + onboarding status |
| `carrier_submissions` | Extended — now has broker fields + FMCSA result |
| `pickup_codes` | 6-digit dispatch fraud prevention codes |
| `dispatch_verifications` | Driver arrival confirmations with GPS + geofence result |

### Broker dashboard tables (added Directive 1)
| Table | Purpose |
|-------|---------|
| `broker_accounts` | Broker companies (e.g. Logistics Xpress) |
| `broker_users` | Broker users with role (owner/ops/reviewer) |
| `broker_policies` | Per-broker qualification rules seeded from Kate's form |
| `carrier_documents` | COI, W9, agreements, photos |
| `carrier_notes` | Internal broker notes on carriers |
| `activity_logs` | Full audit trail |
| `session` | Express session store |

---

## 4. KATE GONZALEZ — FIRST BROKER

- Company: Logistics Xpress (formerly Vegastar Brokerage)
- MC#: 064447
- Email: kateloads@logisticsxpress.com / kate@logisticsxpress.com
- TMS: Port TMS
- Load boards: DAT
- Current tools: RMIS, Carrier411, Outlook, Teams, QuickBooks, SharePoint
- Policy: all defaults seeded from her form response (April 7, 2026)
- Key pain points: manual insurance/VIN verification, inundated with non-qualifying carriers

---

## 5. SLACK / AGENT SETUP

- Workspace: connectedcarriers.slack.com
- Bot: CC Agent Dispatcher (A0ARULHN57T)
- Channel: #cc-agent-logs (ID: `C0ARKBC5VRA`) — public channel despite lock icon
- Directive pattern: `CC AGENT — [directive]`
- Event subscriptions required: `message.channels` AND `message.groups` (both needed)
- Bot joined channel via `conversations.join` API (requires `channels:join` scope)

---

## 6. GOOGLE WORKSPACE

- Domain: connectedcarriers.org (verified in GoDaddy)
- Email: admin@connectedcarriers.org
- Plan: Starter ($16.80/mo)
- **Trial ends: April 20, 2026 — decide keep or replace**

---

## 7. CARRIER TIERS (BUSINESS DECISIONS — DO NOT CHANGE IN CODE)

| Tier | Criteria |
|------|----------|
| Tier 1 Preferred | In Port TMS + 3+ loads + clean history → bypasses screening |
| Tier 2 Approved | New carrier, passes hard stops → standard onboarding |
| Tier 3 Conditional | Passes minimums, needs review → manual review queue |
| Rejected | Fails any auto-disqualifier → instant rejection |

---

## 8. NEXT STEPS (PRIORITY ORDER)

1. **Directive 2** — Carrier intake + fast qualification gate (in progress)
2. **Add Twilio env vars to Railway** — `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_PHONE_NUMBER`
3. **Deploy automation** — `CC AGENT — migrate` directive via Slack listener
4. **Custom domain** — point `app.connectedcarriers.org` to broker dashboard
5. **Google Workspace decision** — April 20 deadline
6. **Directive 3** — Dispatch packet + truck-roll clearance

---

## 9. PRODUCT ROADMAP

```
Layer 1 (NOW):  Carrier qualification portal — active build
Layer 2 (NEXT): Performance memory per carrier per load
Layer 3:        Network intelligence across multiple brokers
Layer 4:        Load marketplace for pre-screened carriers
```

---

## 10. KEY LESSONS / GOTCHAS

- Railway proxy hostname only reachable from inside Railway network — use public URL for local migrations
- #cc-agent-logs reports as public via API despite lock icon in UI — needs `message.channels` event subscription
- Claude's Slack tool is connected to Signature Fencing workspace, NOT Connected Carriers
- Express apps behind Railway proxy need `app.set("trust proxy", 1)` for secure cookies to work
- Broker dashboard migrations run automatically on startup via `migrate()` in index.ts
