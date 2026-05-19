# ADR-0004: Insurance Verification Waterfall

## Status

Accepted — built and smoke-tested (May 18, 2026).

## Context

Freight brokers are liable for negligent carrier selection under the Supreme Court's Montgomery v. Caribe Transport II ruling (May 2026). Brokers need documented, timestamped evidence that they verified a carrier's insurance coverage before dispatching a load — specifically that the confirmed truck is covered under an active policy.

Insurance certificates (ACORD 25) are not standardized in practice. Some list vehicle VINs explicitly, some bury them in ACORD 101 remarks pages, and some list "Scheduled Autos" with no VINs at all. Brokers currently verify coverage by manually reviewing documents and calling insurance companies. CC automates the document-based portion of this process.

This ADR covers the insurance verification branch of the Dispatch Package. It runs after the carrier has confirmed a specific driver and truck for a load.

## Decision

Insurance verification is document-based, runs inside the Dispatch Package after driver/truck confirmation, and produces one of three results: **CLEAR**, **REVIEW**, or **DO NOT DISPATCH**.

### Position in the CC Spine

1. Broker creates load → generates load apply link.
2. Broker posts link on DAT/Truckstop.
3. Carrier applies → enters MC → passes FMCSA screen → submits interest.
4. Broker assigns carrier.
5. Carrier confirms driver and truck.
6. **CC evaluates CDL + cab card + insurance for the confirmed dispatch package.**
7. CLEAR / REVIEW / DO NOT DISPATCH → arrival signal.

Insurance verification is step 6, running in parallel with CDL and cab card evaluation.

### Core Principles

- **Verification is per-truck, not per-carrier.** The question is: is this specific truck covered? Not: does this carrier have insurance?
- **Document-based, not insurer-confirmed.** CC verifies what the documents say. It does not call insurance companies or query insurer APIs. This is a known limitation, not a bug.
- **OCR uncertainty = REVIEW, not CLEAR.** If the system can't parse a critical field, a human looks at it.
- **Coverage thresholds are broker-configurable.** No hardcoded $1M. Each broker sets their own minimums.
- **Non-response is a signal.** Carrier doesn't provide documents within the time window → DO NOT DISPATCH, with the reason shown to the broker.
- **Named insured must match FMCSA record.** A carrier whose COI legal name doesn't match their FMCSA-registered entity is flagged.

### Result Definitions

- **CLEAR:** Policy active, named insured matches, coverage meets broker thresholds, confirmed truck is covered (VIN match or blanket). Insurance branch passes.
- **REVIEW:** Something needs a human look — named insured mismatch, VIN mismatch, coverage below threshold, OCR couldn't parse a critical field, or pending cancellation. Broker sees the specific issue and raw document.
- **DO NOT DISPATCH:** Hard failure. Policy expired, or carrier did not respond within the time window. Not a judgment call.

### Secondary Path

The primary flow is DAT inbound (carrier applies through load link). A secondary path exists for broker-direct verification — broker enters MC + phone, CC sends SMS with magic link. The insurance waterfall runs identically either way.

## What Is Built

- COI upload via carrier verification form (SMS magic link)
- OCR extraction of insurance cert fields
- VIN extraction from cab card
- Basic expiration date checking
- Carrier profile document caching (repeat carriers reuse current docs)
- Escalation timeline (15/30/60 min reminders)
- CLEAR / REVIEW / DO NOT DISPATCH result delivery

## What Is Not Built Yet

- Declarations page request (fourth document type, requested when COI is ambiguous)
- Any Auto vs Scheduled Autos parsing and branching logic
- Named insured matching against FMCSA legal name
- Broker-configurable coverage thresholds (currently implied $1M)
- OCR confidence scoring (low confidence → REVIEW instead of CLEAR)
- ~~REVIEW result tier (currently binary CLEAR vs DO NOT USE)~~ ✅ Built — result tiers are now CLEAR / REVIEW / DO NOT DISPATCH
- Insurance reasoning display in broker dashboard

## Consequences

- Brokers get a documented, timestamped insurance verification trail for each dispatch.
- The system is honest about its limitations — document-based, not insurer-confirmed.
- The declarations page fallback handles the real-world inconsistency of ACORD 25 forms (validated against three real carrier certificates from Kate's workflow).
- Build priority should follow the spec at `docs/specs/INSURANCE-VERIFICATION-WATERFALL.md`.

## References

- Full operational spec: `docs/specs/INSURANCE-VERIFICATION-WATERFALL.md`
- Real certificate examples analyzed: KIK LLC (blanket/remarks VIN), Signature Brand Logistics (explicit VINs), Phamile 1st LLC (no VINs)
- Montgomery v. Caribe Transport II, LLC — U.S. Supreme Court, May 2026
