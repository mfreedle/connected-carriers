# Connected Carriers — Documentation Index

**Last updated:** May 18, 2026

## What is Connected Carriers?

Connected Carriers is a dispatch clearance platform for freight brokers. A broker posts a load, unknown carriers self-qualify through FMCSA screening, and CC verifies the dispatch package (CDL, cab card, insurance) for the specific driver and truck assigned to that load. The broker gets CLEAR / REVIEW / DO NOT DISPATCH with the reasoning — no phone calls, no manual document comparison.

Built under the parent brand HoneXAI. Pilot user: Kate Gonzalez (Logistics Xpress, MC#064447).

---

## Current Architecture

```
Broker app (app.connectedcarriers.org)
  └─ Owns all canonical business state:
     loads, applications, assignments, carriers, drivers,
     equipment, documents, verifications, dispatch signals

MCP server (cc-mcp-server-production.up.railway.app)
  └─ Public edge: driver arrival confirmation, MCP tools,
     legacy compatibility. Owns no canonical business data.

Carrier identity is MC-level (one carrier = one MC number).
Dispatch package is driver + equipment + load-level.
Insurance waterfall lives inside dispatch package evaluation.
```

---

## Canonical Documents

### Start here
| Doc | Path | Purpose |
|-----|------|---------|
| **This index** | `docs/README.md` | Where to look for what |
| **Handoff** | `docs/HANDOFF.md` | Current operational state, services, credentials, deploy process |
| **Positioning** | `docs/POSITIONING.md` | How CC relates to Carrier411, Tai TMS, Highway |

### Architecture Decision Records
Decisions that shaped the system. Read these before changing core behavior.

| ADR | Path | Status |
|-----|------|--------|
| ADR-0001: Carrier Journey | `docs/adr/ADR-0001-carrier-journey.md` | Accepted |
| ADR-0002: Broker Journey | `docs/adr/ADR-0002-broker-journey.md` | Accepted |
| ADR-0003: Auth & Broker Access | `docs/adr/ADR-0003-authentication-and-broker-access.md` | Accepted |
| ADR-0004: Insurance Waterfall | `docs/adr/ADR-0004-insurance-verification-waterfall.md` | Accepted — built and smoke-tested |

### Specs
Operational detail for specific subsystems. These evolve as we learn.

| Spec | Path | What it covers |
|------|------|----------------|
| Insurance Verification Waterfall | `docs/specs/INSURANCE-VERIFICATION-WATERFALL.md` | OCR fields, Any Auto vs Scheduled Autos, dec page request, broker thresholds, escalation, result definitions |
| Carrier Identity Spine | `docs/specs/CARRIER-IDENTITY-SPINE.md` | MC-level identity, driver/equipment modeling, document storage |

### Product Spines
End-to-end workflow promises. These define "what must remain true" — not implementation details.

| Spine | Path | Status |
|-------|------|--------|
| SPINE-0001: Broker Load | `docs/spines/SPINE-0001-broker-load.md` | Built |
| SPINE-0002: Carrier Identity | `docs/spines/SPINE-0002-carrier-identity.md` | Built |
| SPINE-0003: Carrier Profile | `docs/spines/SPINE-0003-carrier-profile.md` | Built |
| SPINE-0004: Assignment | `docs/spines/SPINE-0004-assignment.md` | Built |
| SPINE-0005: Verification Chase | `docs/spines/SPINE-0005-verification-chase.md` | Built |
| SPINE-0006: Dispatch Signal | `docs/spines/SPINE-0006-dispatch-signal.md` | Built |
| SPINE-0007: Trust & Access | `docs/spines/SPINE-0007-trust-ownership-access.md` | Built |
| SPINE-0008: Inbound Carrier Filter | `docs/spines/SPINE-0008-inbound-carrier-filter.md` | Built — the front door |
| SPINE-0009: Dispatch Package | `docs/spines/SPINE-0009-dispatch-package.md` | Built — driver/equipment/insurance evaluation |
| SPINE-0010: Carrier Master Record | `docs/spines/SPINE-0010-carrier-master-record.md` | Built — MC + driver + equipment + documents |

### Test Fixtures
| Doc | Path | Purpose |
|-----|------|---------|
| Insurance Waterfall Fixtures | `app/test/fixtures/README.md` | Three deterministic carrier scenarios for smoke testing evaluator branches |

---

## Where to Look Before Changing...

| If you're changing... | Read first |
|----------------------|------------|
| Load creation, posting, application flow | SPINE-0001, SPINE-0008 |
| Carrier identity, MC resolution | SPINE-0002, `carrier-identity.ts` |
| Assignment, confirmation, dispatch package | SPINE-0004, SPINE-0009, ADR-0004 |
| Insurance verification, COI parsing, dec pages | ADR-0004, `specs/INSURANCE-VERIFICATION-WATERFALL.md` |
| Document upload, OCR, carrier_documents | SPINE-0010, `doc-parser.ts` |
| SMS sending, Twilio, escalation | SPINE-0005, `verify-cron.ts`, HANDOFF.md |
| Geofence, arrival confirmation | SPINE-0006, `dispatch-signal.ts` |
| MCP server, legacy routes | HANDOFF.md (MCP section) |
| Dashboard, broker UI | `routes/loads.ts`, `routes/canonical-loads.ts` |
| Auth, sessions, broker access | ADR-0003 |

---

## Historical vs Current

The system was rebuilt around a spine architecture on May 12–13, 2026. Some artifacts predate that rebuild:

- **`carrier_verifications` table** — the old broker-direct verification flow (MC + phone → SMS → documents). Still functional. Uses CAUTION / DO_NOT_USE terminology. The Dispatch Package flow uses the newer CLEAR / REVIEW / DO_NOT_DISPATCH terminology via `load_assignments`.
- **MCP server `loads` / `load_applications` tables** — deprecated. Canonical load state lives in `canonical_loads` / `canonical_load_applications` in the broker app DB.
- **`carrier_submissions` table** — legacy. Replaced by `carrier_documents` with `doc_type` and `parsed_data`.

When in doubt, the broker app DB tables prefixed with `canonical_` or documented in the spines are authoritative.
