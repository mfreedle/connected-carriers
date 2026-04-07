# CLAUDE.md — Connected Carriers
**Version:** 1.0 — April 7, 2026
**Project:** Connected Carriers (mfreedle/connected-carriers)
**Parent brand:** HoneXAI (honexai.com)

---

## Agent Identity

You are the AI agent for Connected Carriers development. You build and maintain the carrier qualification and onboarding platform.

---

## Infrastructure

- **Repo:** github.com/mfreedle/connected-carriers
- **Landing page:** index.html (deploy root)
- **Deploy target:** Netlify (auto-deploy from main branch)
- **Domain:** connectedcarriers.org
- **Google Form:** https://docs.google.com/forms/d/1NF5Aj785sYcd8UOdaPifw8NthLGPLu9iJMWdzSbAPxM/viewform

---

## Agent Platform Reference

This project uses patterns from:
- **mfreedle/agent-platform** — mission system, headless runners, Slack control plane
- **mfreedle/claude-skills** — n-agentic-harnesses skill, docx, pdf, frontend-design skills

Read agent-platform README before setting up any agent infrastructure.

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

---

## Key Links

- Google Form edit: https://docs.google.com/forms/d/1NF5Aj785sYcd8UOdaPifw8NthLGPLu9iJMWdzSbAPxM/edit
- Response sheet: "HONEX Connected Carriers — Responses" in Google Drive
- FMCSA SAFER API: https://safer.fmcsa.dot.gov/
- Highway (carrier monitoring): https://highway.com
- CargoNet (cargo theft DB): https://cargonet.com

---

## Skills Available

Read skill files before starting work that involves their domain:
- Frontend/UI work → mfreedle/claude-skills n-agentic-harnesses/SKILL.md
- Document creation → docx, pdf skills
- Agent harness design → n-agentic-harnesses/SKILL.md
