# SPINE-0004: Assignment Spine

## Purpose

The assignment spine is the hinge between filtering applicants and clearing a dispatch. It begins when the broker chooses a carrier for a load.

## User Promise

When the broker clicks "Assign Carrier," the system should start the correct downstream work automatically and show what happened.

## Trigger

Authenticated broker selects an applicant and clicks "Assign Carrier."

## Actors

- Broker user
- Assigned carrier
- System verification/chase automation
- Dispatch signal automation

## Required Representation

The prototype currently represents assignment through:

- `loads.assigned_applicant_id`
- `load_applications.assigned_at`
- `load_applications.verification_token`
- `load_applications.verification_status`

Because nothing is live yet, the correct implementation should introduce `load_assignments` before the pilot instead of hardening this implicit representation.

## Table

`load_assignments` should represent the assignment explicitly:

```sql
CREATE TABLE load_assignments (
  id SERIAL PRIMARY KEY,
  load_id INTEGER NOT NULL,
  broker_account_id INTEGER NOT NULL,
  carrier_id INTEGER NOT NULL,
  load_application_id INTEGER NOT NULL,
  assigned_by_user_id INTEGER,
  carrier_verification_id INTEGER,
  dispatch_verification_id INTEGER,
  status TEXT NOT NULL,
  assigned_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
```

## Required Flow

1. Verify broker owns the load.
2. Verify applicant belongs to the load.
3. Resolve carrier identity.
4. Check latest reusable carrier profile.
5. If profile is dispatch-ready, skip document chase and start dispatch signal when appropriate.
6. If profile is missing/stale, start verification chase.
7. Store downstream token/result against the assignment.
8. Update broker dashboard status.

## Assignment Status

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

## UI Promise

After assignment, the broker should see:

- Which carrier was assigned.
- Whether docs were skipped or requested.
- Whether the carrier is clear, caution, or do not use.
- Whether arrival signal was sent.
- What the next action is.

## Failure States

- Applicant has no phone.
- Verify trigger fails.
- Carrier is rejected by FMCSA on assignment.
- Carrier does not submit docs.
- Broker assigns the wrong carrier and needs to supersede.
- Arrival signal is created but not tied back to assignment.

## Must Never Happen

- Assignment from a public unauthenticated route.
- Assignment to an applicant on another broker's load.
- Load marked covered without showing verification state.
- Reassignment leaves old carrier with an active dispatch request.

## Current Gaps To Resolve

- Direct MCP assignment endpoint still exists and mutates state if called directly.
- No first-class assignment table yet; add it as part of the rebuild before Kate's pilot.
- Dispatch signal linkage should reference the original load or assignment, not only a generated verification ID.
