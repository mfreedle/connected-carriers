# ADR-0002: Broker Journey - From Posting to Dispatch Clearance

## Status

Accepted.

## Context

The broker workflow should make Kate's real operating path simple: post a load, let carriers qualify themselves, assign the best carrier, and receive dispatch clearance without manually chasing documents.

## Decision

The broker journey is:

1. Broker posts a load in the dashboard.
2. System generates a shareable `/load/:slug` link.
3. Broker posts that link on DAT, Truckstop, or another load board.
4. Carriers qualify themselves by entering MC number.
5. Qualified carriers submit interest.
6. Broker receives SMS notifications for qualified carrier interest when broker phone is present.
7. Broker reviews applicants in the dashboard.
8. Broker expands an applicant to see inline profile information when available.
9. Broker clicks "Assign Carrier."
10. Assignment automatically starts the dispatch verification/chase flow.
11. Carrier receives an SMS magic link requesting required dispatch documents if the profile is incomplete.
12. OCR and rule checks run.
13. Broker receives CLEAR, CAUTION, or DO NOT USE tied to the specific load assignment.
14. If CLEAR, broker dispatches the carrier in Port TMS or the broker's TMS of record.

This is the product promise: Filter, Chase, Signal.

## Existing Behavior

- Load posting and shareable links work.
- Carrier FMCSA check and interest capture work.
- Applicant review and inline profile display work.
- Assign carrier button exists.
- `/api/verify/trigger` exists in the broker app.

## Gaps

- Assigning a carrier does not call the verify trigger.
- Verification results are not clearly tied back to the specific load assignment in the broker dashboard.
- The dashboard does not yet present a complete assignment state machine from applicant to dispatch-ready.

## Required Assignment States

An assigned carrier should move through these states:

- `assigned`
- `verification_requested`
- `documents_pending`
- `clear`
- `caution`
- `do_not_use`
- `superseded`
- `cancelled`

## Implementation Notes

- On assignment, check whether the carrier has a dispatch-ready profile.
- If the profile is complete, skip document chase and proceed to dispatch clearance or arrival signal.
- If the profile is incomplete, call `/api/verify/trigger` with load, broker, carrier, and contact context.
- Store the verification token/result against the load assignment, not only against the carrier.
- Surface CLEAR, CAUTION, or DO NOT USE in the load applicants view and the load detail view.
