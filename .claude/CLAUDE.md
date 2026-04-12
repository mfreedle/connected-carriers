# CLAUDE.md — Connected Carriers
**Version:** 2.0 — April 12, 2026
**Project:** Connected Carriers (mfreedle/connected-carriers)
**Parent brand:** HoneXAI (honexai.com)

---

## Standalone System Declaration

Connected Carriers is a standalone system.
There is no external code owner constraint (Ajith does not apply).
Claude can make architectural decisions freely within this repo, prioritizing clarity and speed over compatibility with HONEX.

Build for Kate being operationally faster and safer.
Not for generalizability. Not for enterprise extensibility. Not for future multi-repo compatibility.

Speed + clarity > extensibility, every time.

---

## Agent Identity

You are the AI agent for Connected Carriers development. You build and maintain the carrier qualification and dispatch workflow platform. You are NOT the HONEX site services agent.

---

## Infrastructure

- **Repo:** github.com/mfreedle/connected-carriers
- **Token:** ${GITHUB_TOKEN}
- **Broker dashboard:** github-repo-production-2c39.up.railway.app (Railway, auto-deploy from main)
- **MCP server:** cc-mcp-server-production.up.railway.app
- **Landing page:** connected-carriers-production.up.railway.app
- **Domain:** connectedcarriers.org
- **VPS:** root@137.184.36.72 (SSH key auth)
- **Slack channel:** C0ARKBC5VRA (#cc-agent-logs, Connected Carriers workspace)

---

## Product Context

A carrier qualification and dispatch clearance platform for freight brokers. Kate sends intake links to carriers after DAT responses, reviews them through the broker dashboard, and dispatches cleared loads through the dispatch packet workflow.

### Carrier Tiers
- **Tier 1 Preferred:** In Port TMS + 3+ loads + clean history
- **Tier 2 Approved:** New carrier, passes all hard stops
- **Tier 3 Conditional:** Passes minimums, needs manual review
- **Rejected:** Fails any auto-disqualifier

### Record Lifecycle
intake link → carrier submits form → FMCSA verification → auto-reject or queue → Kate reviews → approved → dispatch packet → clearance → pickup code (if policy requires)

---

## Design System

```
--slate:   #1C2B3A
--amber:   #C8892A
--cream:   #F7F5F0
--serif:   Playfair Display
--sans:    DM Sans
```

---

## Protected — Never Touch

- `assets/` — brand assets, only update intentionally
- Google Form (live) — do not modify without explicit direction
- Carrier tier definitions — business decisions, not code decisions
- HONEX files — separate project, do not touch

---

## Standing Rules

- Landing page CTAs must point to the live Google Form URL
- Footer must attribute HoneXAI
- Design system tokens must be preserved in all UI work
- Deploy target is Railway — never Netlify
- All user-supplied values rendered into HTML must use `h()` from `middleware/security.ts`
- All broker POST forms must include a `_csrf` hidden field

---

## Directive Format

Every directive to this project uses this header and nothing else:

```
RISK:
VERIFICATION TARGET:
OUT OF SCOPE:
SYNC:
READ FIRST:
TASK:
DELIVERABLE:
```

SYNC lists files Claude must read before writing any code.
One concern per directive. No Part 1 / Part 2 splits.

---

## What to Keep from HONEX Patterns

Keep:
- Directive discipline
- Audit-first, read before writing
- Clean state machines
- Explicit workflow modeling
- No magic behavior

Drop:
- Multi-owner caution patterns
- Merge anxiety
- Over-defensive architecture
- Premature modularization
- "Future enterprise compatibility" thinking

---

## Key Links

- FMCSA SAFER API: https://safer.fmcsa.dot.gov/
- Google Form: https://docs.google.com/forms/d/1NF5Aj785sYcd8UOdaPifw8NthLGPLu9iJMWdzSbAPxM/viewform
- Response sheet: "HONEX Connected Carriers — Responses" in Google Drive

---

## Agent Infrastructure

### Slack Listener (live on VPS)
- Service: `cc_slack_listener` — RUNNING
- Directive pattern: `CC AGENT — [directive]`
- Fast-path: `CC AGENT — lookup MC<number>` → MCP → result in ~3s
- Event subscriptions: `message.channels` AND `message.groups` (both required)

### Runner Lifecycle Posts (required for any headless runner)
Every headless runner must post START, COMPLETION, and ERROR to #cc-agent-logs via curl.
Use `|| true` so post failure never blocks the runner.
