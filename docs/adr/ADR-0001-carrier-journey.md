# ADR-0001: Carrier Journey - Paths to Dispatch Readiness

## Status

Accepted.

## Context

Connected Carriers supports carriers entering the system from multiple starting points. Those paths should converge into the same durable carrier profile so carriers do not repeatedly re-enter the same information or re-upload the same documents.

## Decision

A carrier can reach dispatch readiness through three paths:

### Path A - Load-First

A carrier sees a load on DAT, Truckstop, or another load board with a Connected Carriers link.

1. Carrier opens `/load/:slug` on the MCP server.
2. Carrier enters MC number.
3. FMCSA verification runs immediately.
4. If qualified, carrier submits name, phone, and email to express interest.
5. Broker receives an SMS notification when broker phone is present.
6. Carrier appears as a qualified applicant for that load.
7. Carrier is prompted to complete a persistent profile for faster qualification on future loads.

This is the lightweight gate. The carrier is qualified for the load, but may not yet be dispatch-ready.

### Path B - Broker-Direct

A broker sends a carrier a self-service intake link.

1. Carrier opens `/intake/:slug` on the broker app.
2. Carrier enters MC number, phone, and email.
3. FMCSA verification runs.
4. If the carrier passes initial checks, they are redirected to `/v/:token`.
5. Carrier uploads dispatch documents such as CDL, insurance, cab card, and truck photo.
6. OCR and rule checks run.
7. Broker receives CLEAR, CAUTION, or DO NOT USE.

This path is broker-initiated and dispatch-oriented.

### Path C - Carrier-Direct

A carrier finds Connected Carriers without a specific load or broker assignment.

1. Carrier clicks a public "Get Verified" or "Complete Your Profile" entry point.
2. Carrier opens `/profile/carrier`.
3. Carrier enters MC number, company info, contact info, driver/equipment details, and uploads documents.
4. FMCSA and document checks run.
5. A persistent `carrier_profiles` record is created or updated.
6. When the carrier later applies to a broker's load, the system recognizes the MC number and shows the carrier as dispatch-ready when profile requirements are met.

This path supports the network flywheel: the more carriers pre-verify, the faster every broker's workflow becomes.

## Data Continuity Rule

Data captured at any step must pass forward. If a carrier already provided MC number, name, phone, and email on the load apply page, any subsequent profile or verification form must pre-fill those fields.

Never ask for the same information twice when the system already has it.

## Existing Behavior

- `/load/:slug` works: FMCSA check runs and interest is captured.
- `/profile/carrier` works: document uploads save to `carrier_profiles`.
- `/intake/:slug` works: broker-directed intake starts verification.
- `/v/:token` works: document upload, OCR, and result delivery exist.

## Gaps

- Load apply does not pass captured MC, name, phone, and email into the profile form.
- Load apply captures interest only; it does not directly start the verify flow.
- Carrier-direct profile submission is not positioned clearly from the public site.
- Carrier-direct profile submission does not fully participate in the same FMCSA and OCR verification pipeline as broker-directed verification.

## Implementation Notes

- Add query params or a short-lived token from `/load/:slug` to `/profile/carrier` so profile fields pre-fill.
- Prefer a token over raw query params if sensitive data expands beyond MC/contact basics.
- Use MC number as the durable matching key for profile reuse.
- Treat `carrier_profiles.completion_status = 'dispatch_ready'` as the signal that a carrier can skip document chase for future load assignments.
