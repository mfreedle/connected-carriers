# ADR-0002: Broker Journey - From Posting to Dispatch Clearance

## Status

Accepted.

## Context

The broker workflow should make Kate's real operating path simple: post a load, let carriers qualify themselves, assign the best carrier, and receive dispatch clearance without manually chasing documents.

This ADR is now interpreted through the product spine architecture in `docs/spines/`. The broker app database is the canonical system of record. MCP may remain as a public edge, but it should not own canonical loads, load applications, assignments, carrier identity, verification, or dispatch signal.

## Decision

The broker journey is:

1. Broker posts a load in the dashboard.
2. System stores the load in the broker app database and generates a shareable `/l/:slug` link.
3. Broker posts that link on DAT, Truckstop, or another load board.
4. Carriers qualify themselves by entering MC number.
5. System resolves carrier identity and links each application to `carrier_id`.
6. Qualified carriers submit interest.
7. Broker receives SMS notifications for qualified carrier interest when broker phone is present.
8. Broker reviews applicants in the dashboard.
9. Broker expands an applicant to see inline profile information when available.
10. Broker clicks "Assign Carrier."
11. System creates a `load_assignments` record.
12. Assignment sends the carrier a confirmation link for the driver/equipment package, or falls back to document chase for legacy/no-package carriers.
13. Carrier confirms driver and truck and uploads only missing/stale documents.
14. OCR, document parsing, and dispatch package evaluation run.
15. Broker receives CLEAR, REVIEW, or DO NOT DISPATCH tied to the specific load assignment.
16. If CLEAR, broker dispatches the carrier in Tai TMS or the broker's TMS of record.

This is the product promise: Filter, Confirm/Evaluate, Chase when needed, Signal when clear.

## Existing Behavior

- Load posting and shareable links work.
- Carrier FMCSA check and interest capture work.
- Applicant review and inline profile display work.
- Assign carrier button exists.
- `/api/verify/trigger` exists in the broker app.

Some existing load and application behavior is prototype-owned by MCP. That is not the target ownership model.

## Historical Gaps

These gaps drove the spine rebuild and should not be reintroduced:

- Canonical load/application ownership belongs in the broker app database.
- Assignment is first-class through `load_assignments`.
- Verification and dispatch package results must tie back to a specific assignment in the broker dashboard.
- Dispatch signal must tie back to a specific load assignment and exact pickup location.
- Driver/equipment-level dispatch package states must remain visible to Kate.

## Required Assignment States

An assigned carrier should move through these states:

- `assigned`
- `verification_requested`
- `documents_pending`
- `clear`
- `review`
- `do_not_dispatch`
- `needs_dec_page`
- `dec_page_no_response`
- `arrival_pending`
- `arrival_confirmed`
- `arrival_alert`
- `superseded`
- `cancelled`

## Implementation Notes

- On assignment, send carrier confirmation for the selected driver/equipment package. MC-level profile completeness is fallback/legacy only.
- If the dispatch package is complete, skip document chase and proceed to dispatch clearance or arrival signal.
- If the profile is incomplete, call `/api/verify/trigger` with load, broker, carrier, and contact context.
- Store the verification token/result against `load_assignments`, not only against the carrier.
- Surface CLEAR, REVIEW, or DO NOT DISPATCH in the load applicants view and the load detail view.
- Store exact pickup address and structured pickup window on the load and pass them into dispatch signal.
