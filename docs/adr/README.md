# Architecture Decision Records

Connected Carriers ADRs define the intended product behavior and the implementation gaps that should guide future work.

These ADRs should be read together with the product spine documents in `../spines/`. The spine documents define the current architecture direction: the broker app database is the canonical system of record, and MCP is optional public edge infrastructure rather than a canonical business-data owner.

## Records

- [ADR-0001: Carrier Journey - Paths to Dispatch Readiness](ADR-0001-carrier-journey.md)
- [ADR-0002: Broker Journey - From Posting to Dispatch Clearance](ADR-0002-broker-journey.md)
- [ADR-0003: Authentication and Broker Access](ADR-0003-authentication-and-broker-access.md)
- [ADR-0004: Insurance Verification Waterfall](ADR-0004-insurance-verification-waterfall.md)
