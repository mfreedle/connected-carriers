# SPINE-0001: Broker Load Spine

## Purpose

The broker load spine is the broker's workbench. It starts when a broker creates a load and ends when the load is dispatched, cancelled, or otherwise closed.

For the pilot, this is Kate's core workflow. Long term, it must work for any broker account.

## User Promise

The broker can post a load link, let carriers qualify themselves, see the best applicants first, assign one carrier, and know what to do next without manually stitching together texts, documents, and FMCSA checks.

## Trigger

A broker creates a load from the authenticated broker dashboard.

## Actors

- Broker user
- Broker account
- Carrier applicants
- System automation

## Data Created

- `loads`
- `load_applications`
- `load_assignments`
- Verification and dispatch records downstream

These tables should live in the broker app database. MCP may serve public load pages temporarily, but it should not own canonical load or application records.

## Required Flow

1. Broker enters load details.
2. System stores broker ownership.
3. System generates a public `/load/:slug` link.
4. Broker posts the link to DAT, Truckstop, or another board.
5. Carriers apply through the link.
6. Broker dashboard shows applicants on the load.
7. Broker assigns one carrier.
8. System starts document chase or dispatch signal.
9. Broker sees operational status and next action.

## Required Load Data

- Broker account ID
- Broker reference or load number
- Origin city
- Destination city
- Equipment
- Pickup date
- Exact pickup address for signal/geofence
- Pickup window in structured form
- Broker contact phone/email for notifications
- Status

## Status Model

Broker-facing status should be operational, not technical:

- `posted`: load is live, no applicants yet
- `carriers_qualified`: carriers have passed initial checks
- `ready_to_call`: at least one carrier has passed the FMCSA gate and submitted contact info; broker-facing label should be "FMCSA PASS - Need Documents"
- `assigned`: broker selected a carrier
- `waiting_on_docs`: assigned carrier needs document completion
- `clear_to_dispatch`: carrier is clear for dispatch
- `review`: carrier has flags requiring broker judgment
- `do_not_use`: carrier failed hard checks
- `arrival_sent`: driver has arrival confirmation link
- `on_site`: driver confirmed at pickup within acceptable geofence
- `no_response`: driver did not confirm after reminders
- `location_alert`: driver confirmation is too far from pickup
- `covered`: load is closed/covered
- `cancelled`: load cancelled

## UI Promise

The broker dashboard must answer:

- How many loads need action?
- Which load needs action first?
- Which carrier should I call or assign?
- What is blocking dispatch?
- What happened after assignment?

## Failure States

- Load creation fails.
- Broker context is missing.
- Load link is copied but not associated to broker.
- Applicant list fails to load.
- Assignment succeeds but verification fails.
- Dispatch signal is created but not tied back to the load.

## Must Never Happen

- A broker sees another broker's loads.
- A public caller creates or mutates broker-owned load state.
- A load exists without broker ownership.
- The dashboard shows a load as clear when verification failed or is unknown.

## Current Gaps To Resolve

- Move canonical `loads` and `load_applications` out of MCP ownership and into broker app ownership.
- Public `/load/:slug` should be served by the broker app or proxy to broker-app-owned APIs.
- Pickup window should be structured enough for reminder and alert logic.
- Arrival signal must tie back to the original load/assignment.
- The public board should be clearly a read-only preview or removed from broker workflow.
