# Connected Carriers — Project Handoff
**Last updated:** April 8, 2026
**Status:** Slack listener running. MCP server live. FMCSA integration next.

---

## 1. BRAND ARCHITECTURE (DECIDED)

| Brand | Domain | Role |
|-------|--------|------|
| **HoneXAI** | honexai.com | Parent platform / technology company |
| **Connected Carriers** | connectedcarriers.org (owned) | Consumer-facing carrier network product |
| HONEX | honex.com | Existing site services brand — separate |

**Domain moat owned:** honex.com, honnex.com, honexai.com, honex.ai + variations
**connectedcarriers.com** — redirects to hotshottrucking.com (too expensive for MVP)
**connectedcarrier.com** (singular) — available ~$3,200, not needed for MVP

---

## 2. INFRASTRUCTURE — CURRENT STATE

### Railway Services (all live)
| Service | URL | Status |
|---------|-----|--------|
| Landing page | connected-carriers-production.up.railway.app | Online |
| Postgres | internal | Online |
| MCP server | cc-mcp-server-production.up.railway.app | Online |

### MCP Server
- Health check: `GET https://cc-mcp-server-production.up.railway.app/health`
- Returns: `{"status":"ok","service":"cc-mcp-server","version":"1.0.0"}`
- Tools registered: `cc_lookup_carrier`, `cc_verify_carrier`, `cc_assign_tier`
- **`lookupFMCSA` in `mcp-server/src/index.ts` is scaffolded but NOT yet implemented — this is the next build**

### VPS Agent Listener
- VPS: `root@137.184.36.72` (DigitalOcean)
- Service: `cc_slack_listener` — **RUNNING as of April 8, 2026**
- Listener: `/home/connected-carriers/scripts/slack_listener.py`
- Env file: `/home/connected-carriers/.env`
- Slack channel: `C0ARKBC5VRA` (#cc-agent-logs)

### GitHub
- Repo: `github.com/mfreedle/connected-carriers`
- Branch: `main` (auto-deploys to Railway)
- Access: GitHub Contents API with token in env

---

## 3. DATABASE SCHEMA (Postgres on Railway)

Auto-provisioned when MCP server was created. Schema initialized, nothing writing yet.

| Table | Purpose |
|-------|---------|
| `carriers` | Cache FMCSA lookups — MC#, authority, safety rating, insurance expiry, tier, timestamp |
| `carrier_submissions` | Log every Google Form submission — status, tier assigned, when |
| `pickup_codes` | 6-digit dispatch fraud prevention codes — sent to verified carrier phone, must match at pickup |

---

## 4. LANDING PAGE (LIVE)

- File: `index.html` (deploy root)
- Live at: connected-carriers-production.up.railway.app
- All CTAs point to Google Form
- Footer attributes HoneXAI
- Design system: slate `#1C2B3A` / amber `#C8892A` / cream `#F7F5F0`

---

## 5. GOOGLE FORM (LIVE)

- Share URL: https://docs.google.com/forms/d/1NF5Aj785sYcd8UOdaPifw8NthLGPLu9iJMWdzSbAPxM/viewform
- Edit URL: https://docs.google.com/forms/d/1NF5Aj785sYcd8UOdaPifw8NthLGPLu9iJMWdzSbAPxM/edit
- Response sheet: "HONEX Connected Carriers — Responses" in Google Drive
- 11 sections covering full carrier qualification

---

## 6. SLACK / AGENT SETUP

- Workspace: connectedcarriers.slack.com
- Bot: CC Agent Dispatcher
- Channel: #cc-agent-logs (ID: C0ARKBC5VRA)
- Socket Mode: enabled, `connections:write` scope confirmed
- Directive pattern: `CC AGENT — [your directive here]`

---

## 7. GOOGLE WORKSPACE

- Domain: connectedcarriers.org (verified in GoDaddy)
- Email: admin@connectedcarriers.org
- Plan: Starter ($16.80/mo)
- **Trial ends: April 20, 2026 — decide keep or replace**
- DKIM setup: attempted, hit 500 error — deferred

---

## 8. CARRIER TIERS (BUSINESS DECISIONS — DO NOT CHANGE IN CODE)

| Tier | Criteria |
|------|----------|
| Tier 1 Preferred | In Port TMS + 3+ loads + clean history → bypasses screening |
| Tier 2 Approved | New carrier, passes hard stops → standard onboarding |
| Tier 3 Conditional | Passes minimums, needs review → manual review queue |
| Rejected | Fails any auto-disqualifier → instant rejection |

---

## 9. NEXT STEPS (PRIORITY ORDER)

1. **Add MCP server as custom connector** in Claude project settings: `https://cc-mcp-server-production.up.railway.app/mcp`
2. **Implement `lookupFMCSA`** in `mcp-server/src/index.ts` — FMCSA SAFER API parser
3. **Delete failed Railway service** — "dependable-flexibility" service (unused)
4. **Point connectedcarriers.org DNS** at Railway in GoDaddy when ready to go live
5. **April 9** — Send Google Form to Kate Gonzalez
6. **April 14** — Review HONEX site services assets for CC reuse
7. **April 20** — Google Workspace trial ends — decide keep or replace

---

## 10. PRODUCT ROADMAP

```
Layer 1 (NOW):  Carrier qualification portal — active build
Layer 2 (NEXT): Performance memory per carrier per load
Layer 3:        Network intelligence across multiple brokers
Layer 4:        Load marketplace for pre-screened carriers
```

**The moat:** Every submission, every qualification decision, every performance data point = a dataset no public database has.

---

## 11. STANDING RULES

- Never modify `assets/` without explicit direction
- Never modify the live Google Form without explicit direction
- Carrier tier definitions are business decisions, not code decisions
- Do NOT touch any HONEX files on the VPS
- Deploy target is Railway — NEVER Netlify
- All CTAs must point to the live Google Form URL
- Footer must always attribute HoneXAI
- Design system tokens (slate/amber/cream) must be preserved

---

*Updated April 8, 2026 — Slack listener running, MCP server live, FMCSA integration next*
