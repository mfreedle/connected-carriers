# Connected Carriers — Project Handoff
**Last updated:** April 11, 2026
**Status:** MCP server v1.2.0 live. FMCSA parser fixed. `/mcp` endpoint fix written, not yet pushed.

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

### MCP Server (v1.2.0 — deployed April 11)
- Health: `GET https://cc-mcp-server-production.up.railway.app/health`
- Tools: `cc_lookup_carrier`, `cc_verify_carrier`, `cc_assign_tier`
- FMCSA parser: **FIXED** — now correctly parses table row structure, returns company name, authority, USDOT status, safety rating
- `/mcp` endpoint: **BROKEN (500)** — fix written, not pushed. See section 9.
- Geocoding: working via Nominatim fallback (no Google key needed)
- SMS (Twilio): not wired — env vars not set in Railway

### VPS Agent Listener
- VPS: `root@137.184.36.72` (DigitalOcean, SSH key auth)
- Service: `cc_slack_listener` — **RUNNING**
- Listener: `/home/connected-carriers/scripts/slack_listener.py`
- Env file: `/home/connected-carriers/.env`
- Slack channel: `C0ARKBC5VRA` (#cc-agent-logs)

### GitHub
- Repo: `github.com/mfreedle/connected-carriers`
- Branch: `main` (auto-deploys to Railway)
- CLAUDE.md: `.claude/CLAUDE.md`

---

## 3. DATABASE SCHEMA (Postgres on Railway)

| Table | Purpose |
|-------|---------| 
| `carriers` | Cache FMCSA lookups |
| `carrier_submissions` | Log every form submission |
| `pickup_codes` | 6-digit dispatch fraud prevention codes |
| `dispatch_verifications` | Driver arrival confirmations with GPS + geofence result |

---

## 4. LANDING PAGE (LIVE)

- File: `index.html` (deploy root)
- Live at: connected-carriers-production.up.railway.app
- Design system: slate `#1C2B3A` / amber `#C8892A` / cream `#F7F5F0`

---

## 5. GOOGLE FORM (LIVE)

- Share URL: https://docs.google.com/forms/d/1NF5Aj785sYcd8UOdaPifw8NthLGPLu9iJMWdzSbAPxM/viewform
- Response sheet: "HONEX Connected Carriers — Responses" in Google Drive
- **Kate Gonzalez has responded — her submission is pending processing**

---

## 6. SLACK / AGENT SETUP

- Workspace: connectedcarriers.slack.com
- Bot: CC Agent Dispatcher
- Channel: #cc-agent-logs (ID: `C0ARKBC5VRA`)
- Canvas ID: `F0ARLQ7ULQL`
- Directive pattern: `CC AGENT — [your directive here]`

---

## 7. GOOGLE WORKSPACE

- Domain: connectedcarriers.org (verified in GoDaddy)
- Email: admin@connectedcarriers.org
- Plan: Starter ($16.80/mo)
- **Trial ends: April 20, 2026 — decide keep or replace**

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

1. **Push `/mcp` endpoint fix** — move tool registrations into `buildMcpServer()` factory, use per-request pattern:
```
if (req.method === "POST" && url === "/mcp") {
  const mcpServer = buildMcpServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  try {
    await mcpServer.connect(transport);
    await transport.handleRequest(req, res, await readBody(req));
    res.on("close", () => { transport.close(); mcpServer.close(); });
  } catch (err) {
    if (!res.headersSent) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: null }));
    }
  }
  return;
}
```
2. **Add Twilio env vars to Railway** — `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_PHONE_NUMBER`
3. **Add MCP server as custom connector** in Claude project settings: `https://cc-mcp-server-production.up.railway.app/mcp`
4. **Process Kate Gonzalez form response** — pull from response sheet, run `cc_verify_carrier` + `cc_assign_tier`
5. **Wire Slack listener** to respond to `CC AGENT — lookup MC[number]` directives via MCP tools
6. Review HONEX site assets for CC reuse — April 14
7. Google Workspace decision — April 20

---

## 10. PRODUCT ROADMAP

```
Layer 1 (NOW):  Carrier qualification portal — active build
Layer 2 (NEXT): Performance memory per carrier per load
Layer 3:        Network intelligence across multiple brokers
Layer 4:        Load marketplace for pre-screened carriers
```

