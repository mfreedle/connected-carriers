# SPINE-0007: Trust, Ownership, and Access Spine

## Purpose

The trust spine defines who can see and mutate broker, carrier, load, assignment, and verification data.

## User Promise

Brokers see their own work. Carriers see only the public or tokenized flows meant for them. Internal services do not trust browser-supplied identity.

## Actors

- Broker user
- Broker account
- Carrier
- Public load visitor
- Broker app
- MCP server
- Background jobs

## Ownership Rules

- Every broker load belongs to one broker account.
- Every broker dashboard query is scoped by broker account.
- Every assignment mutation verifies load ownership.
- Every broker verification is tied to broker account.
- Carrier profiles may be network reusable only with consent.
- Broker-specific decisions stay scoped to broker/load/assignment.

## Public Routes

Allowed public behavior:

- View load apply page.
- Submit MC for load qualification.
- Submit interest/contact info for a specific load.
- Submit carrier profile.
- Open tokenized verification link.
- Open tokenized tracking/arrival link.

Not allowed public behavior:

- Assign carrier.
- View broker dashboard data.
- Mutate load ownership or broker identity.
- Supply trusted broker account identity.

## Broker Routes

Broker routes require session authentication and CSRF protection on mutating requests.

Examples:

- Create load
- View broker loads
- View applicants
- Assign carrier
- View reports
- Update broker settings

## Service Boundary

The broker app is the system of record. MCP, if retained, is a public edge or compatibility layer only.

For the rebuild:

- Public carrier pages may be served from the broker app directly.
- If MCP serves public carrier pages, it should forward writes to broker-app-owned APIs.
- MCP should not own canonical carrier, load, application, assignment, verification, or signal records.

For production:

- Any MCP-to-broker-app call should use service authentication.
- Broker context should be derived from broker-app-owned load records, not public request parameters.

## CSRF Rules

- HTML form POSTs include `_csrf`.
- JSON API POSTs include `X-CSRF-Token`.
- CSRF applies to authenticated broker mutations.
- Public tokenized carrier flows rely on unguessable tokens and route-specific validation.

## Must Never Happen

- Browser supplies `broker_account_id` and MCP trusts it as identity.
- Broker sees another broker's loads or applicants.
- Public board can assign carriers.
- CSRF is skipped for broker mutating routes.
- A tokenized carrier route leaks broker dashboard data.

## Current Gaps To Resolve

- MCP still owns and mutates core records in the prototype.
- Core records should move to broker app ownership before pilot hardening.
- Service auth is needed only if MCP remains as a separate public edge.
- Network carrier profile reuse needs explicit consent and data-use boundaries.
