# Connected Carriers

**Carrier qualification and onboarding network. A [HoneXAI](https://honexai.com) product.**

---

## What This Is

Connected Carriers is the front-door carrier filter for freight brokers. Brokers post a load with a Connected Carriers link, unknown carriers self-screen by MC number, and the broker sees qualified interest before wasting time on manual lookups. The system also remembers reusable carrier, driver, equipment, document, and dispatch-readiness data so repeat loads get faster.

**Live:** [connectedcarriers.org](https://connectedcarriers.org)

---

## Brand Architecture

| Brand | Domain | Role |
|-------|--------|------|
| **HoneXAI** | honexai.com | Parent platform / technology company |
| **Connected Carriers** | connectedcarriers.org | Consumer-facing carrier network product |

---

## Carrier Tiers

| Tier | Who | What Happens |
|------|-----|--------------|
| **Tier 1 — Preferred** | In the broker's TMS + 3+ loads + clean history | Bypasses screening, pre-approved |
| **Tier 2 — Approved** | New carrier, passes all hard stops | Standard onboarding, team notified |
| **Tier 3 — Conditional** | Passes minimums, needs review | Manual review queue, team alerted |
| **Rejected** | Fails any auto-disqualifier | Instant rejection, optional auto-response |

---

## Product Roadmap

```
Layer 1 (NOW):  Inbound carrier filter for posted loads
Layer 2 (NEXT): Dispatch package confirmation: carrier confirms driver/truck for this load
Layer 3:        Carrier master record: reusable drivers, equipment, documents, freshness
Layer 4:        Tai/Carrier411 bridge and network intelligence
```

---

## Stack

- **Landing page:** Static HTML (Railway — auto-deploy from main branch)
- **Carrier intake:** Broker-app load links and profile/verification forms
- **Verification:** FMCSA checks, document upload/OCR, dispatch package rules
- **Agent platform:** Built on [mfreedle/agent-platform](https://github.com/mfreedle/agent-platform) patterns
- **Skills:** [mfreedle/claude-skills](https://github.com/mfreedle/claude-skills)

---

## Repo Structure

```
connected-carriers/
  index.html                    — landing page (deploy root)
  assets/
    honexai_final.png           — HoneXAI wordmark (light)
    honexai_wordmark_dark.png   — HoneXAI wordmark (dark)
    connectedcarriers_wordmarks.png — CC wordmark options
  scripts/
    HONEX_ConnectedCarriers_Form.gs — Google Apps Script for form handling
  docs/
    HANDOFF.md                  — project handoff and context doc
    carrier_tiers.md            — tier system design
    spines/                     — product and data-model spines
    competitive_landscape.md    — market analysis
  .claude/
    CLAUDE.md                   — agent governance doc
```

---

## Design System

```
--slate:   #1C2B3A   (primary dark)
--amber:   #C8892A   (accent)
--cream:   #F7F5F0   (warm off-white background)
--serif:   Playfair Display
--sans:    DM Sans
```

---

## Agent Platform

This project uses the same agent harness patterns proven in [Honex Site Services](https://github.com/mfreedle/honex-platform-mirror). See [mfreedle/agent-platform](https://github.com/mfreedle/agent-platform) for the full platform documentation.

Skills reference: [mfreedle/claude-skills](https://github.com/mfreedle/claude-skills)

---

*A HoneXAI product — built April 2026*
