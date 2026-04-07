# CLAUDE.md — Connected Carriers
**Version:** 1.1 — April 7, 2026
**Project:** Connected Carriers (mfreedle/connected-carriers)
**Parent brand:** HoneXAI (honexai.com)

---

## Agent Identity

You are the AI agent for Connected Carriers development. You build and maintain the carrier qualification and onboarding platform. You are NOT the HONEX site services agent — that is a separate project. Stay in your lane.

---

## GitHub Access

Push files to this repo using the GitHub API directly:

- **Token:** ${GITHUB_TOKEN}
- **PUT to:** https://api.github.com/repos/mfreedle/connected-carriers/contents/{path}
- Always get the current file SHA before updating existing files
- Base64 encode content and strip newlines before sending

---

## Infrastructure

- **Repo:** github.com/mfreedle/connected-carriers
- **Landing page:** index.html (deploy root)
- **Deploy target:** Railway (auto-deploy from main branch) — NEVER Netlify
- **Domain:** connectedcarriers.org
- **Google Form:** https://docs.google.com/forms/d/1NF5Aj785sYcd8UOdaPifw8NthLGPLu9iJMWdzSbAPxM/viewform

---

## Product Context

### What Connected Carriers Is
A carrier qualification and onboarding network for freight brokers. Carriers apply once, get verified, and work with multiple brokers. Brokers get pre-screened carriers with automated FMCSA verification and tier assignment.

### The Real Differentiator
Not the verification — the network. Cross-broker carrier performance data that no single broker can see alone. Every load, every on-time delivery, every check call builds a carrier profile that benefits the entire network.

HoneXAI = the technology company
Connected Carriers = the consumer network it runs
honex.ai = where the intelligence layer eventually lives

### Carrier Tiers
- **Tier 1 Preferred:** In Port TMS + 3+ loads + clean history — bypasses screening, pre-approved
- **Tier 2 Approved:** New carrier, passes all hard stops — standard onboarding
- **Tier 3 Conditional:** Passes minimums, needs review — manual review queue
- **Rejected:** Fails any auto-disqualifier — instant rejection

### Fraud Prevention Context
Strategic cargo theft up 1,500% since 2021. Three attack vectors: double brokering, carrier identity cloning, FMCSA system exploitation. Average theft value $273,990 in 2025.

**Pickup Code System (planned feature):**
Generate a unique 6-digit code at dispatch. Send via SMS to the carrier's verified phone number on file. Broker sends the same code to the shipper. Driver presents the code at pickup — codes must match before freight moves. Breaks carrier impersonation because the code goes to the verified contact, not the fraudster who cloned the MC number.

### Product Roadmap
- Layer 1 NOW: Carrier qualification portal — active build
- Layer 2 NEXT: Performance memory per carrier per load
- Layer 3: Network intelligence across multiple brokers
- Layer 4: Load marketplace for pre-screened carriers

---

## MCP Server Plan

Building a custom MCP server (TypeScript, Streamable HTTP transport) that exposes:
- `cc_lookup_carrier` — MC number to FMCSA authority, safety rating, insurance on file
- `cc_verify_carrier` — full carrier submission to pass/fail per criterion
- `cc_assign_tier` — verification results to tier assignment with reasoning

Stack: @modelcontextprotocol/sdk + Zod validation + FMCSA SAFER API
Deploy: Railway service, separate from landing page
Connect: Add as custom connector in Claude project settings

---

## Slack Listener Plan

Connected Carriers will have its own Slack channel and its own agent listener — separate from the HONEX site services Slack control plane. Pattern is identical to agent-platform (mfreedle/agent-platform) but scoped to this project. Do NOT post Connected Carriers agent output to HONEX Slack channels.

---

## Design System

```
--slate:   #1C2B3A   (primary dark)
--slate2:  #243447
--amber:   #C8892A   (accent — unique in freight tech space)
--cream:   #F7F5F0   (warm off-white background)
--serif:   Playfair Display
--sans:    DM Sans
```

---

## Protected — Never Touch

- `assets/` — brand assets, only update intentionally
- Google Form (live) — do not modify without explicit direction
- Carrier tier definitions — business decisions, not code decisions

---

## Standing Rules

- Landing page CTAs must always point to the live Google Form URL
- Footer must always attribute HoneXAI
- Design system tokens (slate/amber/cream) must be preserved in all UI work
- Any new page or component must match the existing design system
- Deploy target is Railway — NEVER Netlify

---

## Key Links

- Google Form edit: https://docs.google.com/forms/d/1NF5Aj785sYcd8UOdaPifw8NthLGPLu9iJMWdzSbAPxM/edit
- Response sheet: HONEX Connected Carriers — Responses in Google Drive
- FMCSA SAFER API: https://safer.fmcsa.dot.gov/
- Highway: https://highway.com
- CargoNet: https://cargonet.com

---

## Agent Platform Reference

- mfreedle/agent-platform — mission system, headless runners, Slack control plane patterns
- mfreedle/claude-skills — n-agentic-harnesses, docx, pdf, frontend-design skills

Read agent-platform README before setting up any agent infrastructure for this project.

---

## Skills Available

Read skill files before starting work in their domain:
- Frontend/UI work: frontend-design/SKILL.md
- Document creation: docx, pdf skills
- Agent harness design: n-agentic-harnesses/SKILL.md
