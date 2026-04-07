# Connected Carriers

**Carrier qualification and onboarding network. A [HoneXAI](https://honexai.com) product.**

---

## What This Is

Connected Carriers is a carrier qualification and onboarding platform for freight brokers. It handles the full carrier screening lifecycle — from initial qualification through dispatch verification — with automated FMCSA verification, tier assignment, and performance tracking.

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
| **Tier 1 — Preferred** | In Port TMS + 3+ loads + clean history | Bypasses screening, pre-approved |
| **Tier 2 — Approved** | New carrier, passes all hard stops | Standard onboarding, team notified |
| **Tier 3 — Conditional** | Passes minimums, needs review | Manual review queue, team alerted |
| **Rejected** | Fails any auto-disqualifier | Instant rejection, optional auto-response |

---

## Product Roadmap

```
Layer 1 (NOW):  Carrier qualification portal
Layer 2 (NEXT): Performance memory per carrier per load
Layer 3:        Network intelligence across multiple brokers
Layer 4:        Load marketplace for pre-screened carriers
```

---

## Stack

- **Landing page:** Static HTML (Railway — auto-deploy from main branch)
- **Carrier intake:** Google Form → Google Sheet
- **Verification:** FMCSA SAFER API, CargoNet, Highway
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
    verification_layer.md       — FMCSA + CargoNet + Highway architecture
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
