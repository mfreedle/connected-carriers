# ADR-0001: Carrier Journey - Paths to Dispatch Readiness

## Status

Accepted.

## Context

Connected Carriers supports carriers entering the system from multiple starting points. Those paths should converge into the same durable carrier profile so carriers do not repeatedly re-enter the same information or re-upload the same documents.

This ADR is now interpreted through the product spine architecture in `docs/spines/`. The broker app database is the canonical system of record for carrier identity, profiles, loads, applications, assignments, verifications, and dispatch signal. MCP may remain as a public edge for carrier-facing routes, but it should not own canonical carrier or load workflow data.

## Decision

A carrier can reach dispatch readiness through three paths:

### Path A - Load-First

A carrier sees a load on DAT, Truckstop, or another load board with a Connected Carriers link.

1. Carrier opens `/l/:slug` on the public carrier-facing load page. Older `/load/:slug` links may redirect through MCP as a compatibility edge.
2. Carrier enters MC number.
3. System resolves or creates canonical carrier identity in `carriers`.
4. FMCSA verification runs immediately and updates carrier identity.
5. If the carrier passes the FMCSA gate, carrier submits name, phone, and email to express interest.
6. A `load_applications` row is created in the broker app database and linked to `carrier_id`.
7. Broker receives an SMS notification when broker phone is present.
8. Carrier appears as an `FMCSA PASS - Need Documents` applicant for that load.
9. Carrier is prompted to complete a persistent profile for faster qualification on future loads.

This is the lightweight gate. The carrier passed the first legitimacy screen, but is not dispatch-ready until a dispatch package is verified.

### Path B - Broker-Direct

A broker sends a carrier a self-service intake link.

1. Carrier opens `/intake/:slug` on the broker app.
2. Carrier enters MC number, phone, and email.
3. System resolves or creates canonical carrier identity.
4. FMCSA verification runs.
5. If the carrier passes initial checks, they are redirected to `/v/:token`.
6. Carrier uploads dispatch documents such as CDL, insurance, cab card, and truck photo.
7. OCR and rule checks run.
8. Broker receives CLEAR, CAUTION, or DO NOT USE tied to the verification and assignment context.

This path is broker-initiated and dispatch-oriented.

### Path C - Carrier-Direct

A carrier finds Connected Carriers without a specific load or broker assignment.

1. Carrier clicks a public "Get Verified" or "Complete Your Profile" entry point.
2. Carrier opens `/profile/carrier`.
3. Carrier enters MC number, company info, contact info, driver/equipment details, and uploads documents.
4. System resolves or creates canonical carrier identity.
5. FMCSA and document checks run.
6. A persistent `carrier_profiles` record is created or updated and linked to `carrier_id`.
7. When the carrier later applies to a broker's load, the system recognizes `carrier_id`, but dispatch readiness still depends on the selected driver/equipment package for that load.

This path supports the network flywheel: the more carriers pre-verify, the faster every broker's workflow becomes.

## Data Continuity Rule

Data captured at any step should pass forward through trusted paths. If a carrier already provided MC number, name, phone, and email on the load apply page, subsequent profile or verification forms should pre-fill those fields when the carrier follows a tokenized or otherwise trusted link.

Never ask for the same information twice when the system already has it and the current user is authorized to see it.

## Existing Behavior

- `/l/:slug` works: FMCSA check runs and interest is captured.
- `/profile/carrier` works: document uploads save to `carrier_profiles`.
- `/intake/:slug` works: broker-directed intake starts verification.
- `/v/:token` works: document upload, OCR, and result delivery exist.

Some existing behavior lives in MCP from the prototype. That is not the target ownership model.

## Gaps

- Driver and equipment are not yet modeled as reusable records under a carrier.
- The prototype still has MC-level profile fast paths that must be replaced by dispatch-package checks.
- Carrier-direct profile submission participates in carrier identity, but sensitive returning-carrier prefill must remain token-gated.
- Some MCP compatibility routes remain and should not regain canonical ownership.

## Implementation Notes

- Use tokenized links for sensitive returning-carrier prefill. MC-only links may prefill public company/FMCSA information, but not phone, email, driver, truck, VIN, or document status.
- Use cleaned MC number only to resolve canonical carrier identity. Use `carrier_id` as the durable internal key for profile reuse, applications, and verifications.
- Do not treat MC-level `carrier_profiles.completion_status = 'dispatch_ready'` as sufficient once driver/equipment are modeled. The target rule is: skip chase only when the carrier confirms a current driver and current equipment for the load.
- Move canonical load application writes into the broker app database. MCP should call broker-app-owned APIs if it remains in the public route.
