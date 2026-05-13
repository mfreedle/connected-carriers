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
12. Assignment automatically starts the dispatch verification/chase flow or skips to dispatch signal when profile state allows.
13. Carrier receives an SMS magic link requesting required dispatch documents if the profile is incomplete or stale.
14. OCR and rule checks run.
15. Broker receives CLEAR, CAUTION, or DO NOT USE tied to the specific load assignment.
16. If CLEAR, broker dispatches the carrier in Tai TMS or the broker's TMS of record.

This is the product promise: Filter, Chase, Signal.

## Existing Behavior

- Load posting and shareable links work.
- Carrier FMCSA check and interest capture work.
- Applicant review and inline profile display work.
- Assign carrier button exists.
- `/api/verify/trigger` exists in the broker app.

Some existing load and application behavior is prototype-owned by MCP. That is not the target ownership model.

## Gaps

- Canonical `loads` and `load_applications` should move into broker app ownership.
- Assignment should become first-class through `load_assignments` before pilot hardening.
- Verification results must be tied back to a specific assignment in the broker dashboard.
- Dispatch signal must tie back to a specific load assignment and exact pickup location.
- The dashboard presents the current Filter -> Chase -> Signal state, but driver/equipment-level dispatch package states still need to be modeled.

## Required Assignment States

An assigned carrier should move through these states:

- `assigned`
- `verification_requested`
- `documents_pending`
- `clear`
- `caution`
- `do_not_use`
- `arrival_pending`
- `arrival_confirmed`
- `arrival_alert`
- `superseded`
- `cancelled`

## Implementation Notes

- On assignment, check whether the carrier has a current dispatch package for the selected driver/equipment. Until driver/equipment are modeled, the prototype uses MC-level profile completeness as a temporary fast path.
- If the dispatch package is complete, skip document chase and proceed to dispatch clearance or arrival signal.
- If the profile is incomplete, call `/api/verify/trigger` with load, broker, carrier, and contact context.
- Store the verification token/result against `load_assignments`, not only against the carrier.
- Surface CLEAR, CAUTION, or DO NOT USE in the load applicants view and the load detail view.
- Store exact pickup address and structured pickup window on the load and pass them into dispatch signal.
