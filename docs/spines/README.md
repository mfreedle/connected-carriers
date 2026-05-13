# Connected Carriers Product Spines

## Status

Draft for review before additional implementation.

## Purpose

The prototype has proven that the major pieces can work: load links, FMCSA checks, carrier interest, broker dashboard, carrier profiles, document verification, and SMS. The next step is to define the product spines before adding more code.

A spine is an end-to-end workflow and data model promise. If the spine is healthy, every screen, API route, table, and status label has a clear job. If the spine is vague, the system grows by patches and brokers end up doing the reasoning themselves.

## Product Thesis

Connected Carriers is a broker workflow system with a reusable carrier network underneath it.

For a broker, the product should answer:

- Who is qualified for this load?
- Who is easiest to dispatch?
- Who still needs chasing?
- Who should I avoid?
- What should I do next?

For a carrier, the product should answer:

- Am I qualified?
- What do I need to submit?
- Will this help me get booked faster?
- Will I have to do this every time?

## Architecture Decision

Because the product is still raw and no live production workflow depends on the current split, the broker app database should become the canonical system of record.

The broker app owns:

- broker accounts and users
- carrier identity
- carrier profiles and consent
- loads
- load applications
- load assignments
- carrier verification
- dispatch signal
- audit/history

MCP should not own canonical business data long term. It can remain as a public edge or compatibility layer for carrier-facing routes such as `/load/:slug`, but those routes should read from and write to broker-app-owned APIs or tables.

Target shape:

```text
broker app database
  broker_accounts
  broker_users
  carriers
  carrier_profiles
  carrier_consents
  loads
  load_applications
  load_assignments
  carrier_verifications
  dispatch_signals

public edge / MCP, if kept
  serves public carrier pages
  forwards writes to broker app
  owns no canonical load, carrier, assignment, or verification state
```

This avoids building a new carrier identity layer across two separate data owners.

## Spine Set

### Infrastructure Spines (built)

1. [Broker Load Spine](SPINE-0001-broker-load.md)
2. [Carrier Identity Spine](SPINE-0002-carrier-identity.md)
3. [Carrier Profile Spine](SPINE-0003-carrier-profile.md)
4. [Assignment Spine](SPINE-0004-assignment.md)
5. [Verification and Document Chase Spine](SPINE-0005-verification-chase.md)
6. [Dispatch Signal Spine](SPINE-0006-dispatch-signal.md)
7. [Trust, Ownership, and Access Spine](SPINE-0007-trust-ownership-access.md)

### Product Spines (the wedge)

8. [Inbound Carrier Filter](SPINE-0008-inbound-carrier-filter.md) — **the front door**
   Kate posts a load on DAT. Unknown carriers enter their MC. CC screens them before Kate wastes time. Built and smoke tested.

9. [Dispatch Package](SPINE-0009-dispatch-package.md) — **per-load readiness**
   Kate assigns a carrier. The carrier confirms driver, truck, and docs for THIS load. CC verifies the dispatch package. Partially built (company level works, driver/equipment level not yet modeled).

10. [Carrier Master Record](SPINE-0010-carrier-master-record.md) — **CC's memory**
    Every carrier interaction makes the next load faster. CC remembers MCs, drivers, trucks, docs, and results so nobody repeats work. Partially built (MC level exists, driver/equipment tables needed).

### Document Storage Rule

Uploaded files should be represented by `carrier_documents`, not stored directly as fields on driver or equipment rows. Driver/equipment rows store the current extracted facts and status; document rows store the file key, parsed data, source, expiration, and supersession history.

### Positioning

CC does not replace Carrier411 or Tai TMS.

- **Carrier411** monitors carriers Kate already works with (authority, insurance, safety, compliance changes)
- **Tai TMS** manages load execution (quoting, booking, tracking, invoicing, carrier onboarding)
- **Connected Carriers** filters unknown inbound carriers and verifies the dispatch package for each load

Carrier411 and Tai manage carriers Kate already knows.
CC filters the ones she hasn't met yet — before she wastes time on them.

## Design Rules Across All Spines

- Every load belongs to a broker account.
- Every carrier-facing path starts by resolving carrier identity.
- Every applicant belongs to one load and one carrier identity.
- Every assignment connects one load, one broker, one carrier, and one applicant.
- Every verification result is tied to the assignment or dispatch event it supports.
- Carrier documents may be reusable across brokers only with carrier consent.
- Broker decisions and dispatch outcomes remain contextual to the broker and load.
- The broker dashboard should show next actions, not raw internal state.

## Build Philosophy

Do not build the whole system at once. Build one vertical slice through the spines:

1. Broker creates a load.
2. Carrier applies through the load link.
3. Carrier identity is resolved.
4. Carrier profile status is recognized.
5. Broker reviews ranked applicants.
6. Broker assigns a carrier.
7. System either chases docs or skips to signal.
8. Broker sees a clear next action.

Everything else should support that slice or wait.

## Recommended Build Order

1. Move the canonical load workflow into the broker app database: `loads`, `load_applications`, and the new `load_assignments`.
2. Implement carrier identity in the broker app database and backfill existing carrier/profile/verification data.
3. Convert public load apply routes to broker-app-owned routes or thin MCP proxy calls.
4. Repair the broker load/applicant path so Kate can reliably create a load and review applicants.
5. Connect document chase to assignment and carrier identity.
6. Connect dispatch signal to assignment, exact pickup address, and pickup window.
7. Add returning-carrier recognition and profile reuse.
8. Add consent capture before network reuse is treated as real.
9. Pilot with Kate using one controlled real carrier flow.

## Open Architecture Decisions

- Should MCP be retained as a thin public edge, or should public carrier pages move fully into the broker app?
- Do we introduce `load_assignments` before Kate tests? Recommendation: yes, because nothing is live and assignment is the workflow hinge.
- Should pickup window be stored as free text, structured start/end timestamps, or both?
- What carrier data can be reused network-wide before explicit consent exists?
- What is the minimum dashboard state Kate needs before the pilot is useful?

## Pilot Readiness Bar

Before Kate uses a real DAT/Truckstop posting, this vertical flow should work without manual database repair:

1. Kate signs in.
2. Kate creates a load with exact pickup address and pickup window.
3. Kate copies one carrier-facing link.
4. A carrier applies and is recognized or created as a carrier identity.
5. Kate sees that applicant ranked correctly.
6. Kate assigns the carrier.
7. The system either requests docs or skips the chase based on current profile state.
8. Kate sees CLEAR, CAUTION, DO NOT USE, waiting on docs, or signal state tied to that load.
9. If signal is sent, the driver confirmation maps back to the same load in Kate's dashboard.
