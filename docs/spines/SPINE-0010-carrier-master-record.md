# SPINE-0010: Carrier Master Record

**Status:** Built — MC-level identity, driver roster, equipment records, carrier_documents with doc_type/parsed_data, declarations page support, and profile reuse across verifications.
**Owner:** Broker app
**Core question this answers:** "What does CC already know about this carrier, so nobody repeats work?"

---

## The Problem

Kate uses Carrier411 for ongoing carrier compliance monitoring. She's moving to Tai TMS for load execution. Both maintain their own carrier records.

CC is not trying to replace either of those. But CC sees carriers at a moment neither tool covers: the first contact on an unknown load. And CC collects data neither tool has: the specific driver, truck, VIN, and doc package for that dispatch event.

If CC doesn't remember what it learns, every load starts from scratch. The carrier re-uploads their CDL. Kate re-screens the same MC. The system re-checks the same insurance. That's the opposite of the product promise.

## The Product Promise

**Every carrier interaction makes the next load faster.**

- First load: carrier enters MC, uploads everything, full verification
- Second load: "Welcome back. Your docs are current. Confirm driver and truck."
- Third load: "Same driver and truck as last time? One tap to confirm."

## What CC Remembers (Not What Carrier411/Tai Remembers)

| CC Owns | Carrier411 Owns | Tai Owns |
|---------|-----------------|----------|
| MC qualification history | Ongoing authority/insurance monitoring | Carrier master in TMS |
| Which loads this MC applied to | FreightGuard reports | Load/shipment records |
| Driver CDL photos + expiration | Company safety ratings | Invoicing/payment |
| Truck VIN + cab card photos | BASIC score tracking | Carrier onboarding packets |
| Insurance VIN match results | Compliance change alerts | Rate agreements |
| Dispatch readiness per load | | |
| Arrival confirmation history | | |
| Which brokers saw which results | | |
| Carrier response patterns (fast, slow, ghosted) | | |

## Current Data Model

```
carriers (built)
  MC-level identity. One row per MC number forever.
  FMCSA data, network status, latest profile/verification refs.

carrier_profiles (built)
  Doc package: CDL, insurance, cab card, VIN, driver info.
  Currently one profile per MC (company level).
  Completion status: partial | complete | dispatch_ready.

carrier_verifications (built)
  Per-broker, per-load verification event.
  Token-based, time-boxed, result: CLEAR / CAUTION / DO NOT USE.

carrier_consents (built)
  SMS and network reuse consent with evidence.

canonical_load_applications (built)
  Per-carrier, per-load interest record.

load_assignments (built)
  Kate's assignment decision, linked to verification and dispatch signal.
```

## Target Data Model (additions)

```
carrier_drivers (not built)
  Per-driver record under a carrier MC.
  CDL number, state, expiration, photo.
  Multiple drivers per MC.

carrier_equipment (not built)
  Per-truck/trailer record under a carrier MC.
  VIN, truck number, trailer number, cab card photo.
  Multiple trucks per MC.

carrier_documents (not built)
  Unified doc storage with expiration tracking.
  Linked to carrier, driver, or equipment.
  Status: current | expiring | expired | superseded.
```

## Where Documents Live

Uploaded files should live in object storage, with `carrier_documents` as the canonical database record for each file. Driver and equipment rows should store the current facts extracted from documents, not own the document file itself.

Example:

- A CDL upload creates a `carrier_documents` row with `doc_type = cdl`, `driver_id`, R2 key, parsed data, expiration date, and status.
- `carrier_drivers` stores the current CDL number, state, expiration, and verification status derived from the latest current CDL document.
- A later CDL upload supersedes the old document row and updates the driver facts.

Same pattern:

- Insurance COI belongs at the carrier/company level, with VIN coverage parsed into document data or a future coverage table.
- Cab card / truck photo belongs to equipment.
- W-9 belongs to carrier/company.
- Arrival confirmation belongs to the load assignment/dispatch signal, not the carrier master.

## Freshness Rules

| Document | Check | Action |
|----------|-------|--------|
| CDL | Expiration date | Flag at 30 days, block at expired |
| Insurance COI | Expiration date | Flag at 30 days, block at expired |
| Cab card | No standard expiration | Valid until replaced |
| FMCSA authority | Can change anytime | Re-check on each load application |
| VIN match | Insurance VINs vs cab card VIN | Flag mismatch, don't block |

## Network Status (on carriers table)

| Status | Meaning |
|--------|---------|
| known | MC seen in system, no docs |
| profile_started | Some info submitted, not complete |
| verified | Full dispatch package on file, docs current |
| stale | Was verified, docs now expired or FMCSA changed |
| blocked | Manually blocked (future: admin action) |

## Design Rules

- CC is not a compliance tool — it's a readiness cache
- Don't duplicate Carrier411's job (ongoing monitoring) — CC checks at the moment of the load and remembers what it learned
- Don't duplicate Tai's job (carrier master in TMS) — CC remembers what Tai doesn't see
- The carrier should never re-upload a current document
- The system should tell the carrier exactly what's missing, not show a blank form
- Broker-specific decisions (Kate rejected this carrier) stay broker-scoped
- Network-wide data (driver facts, equipment facts, document metadata, and reusable documents) is carrier-owned and reusable across brokers only with consent
- Every data point should have a source and timestamp — not just "on file" but "uploaded May 12, 2026 via load apply for HX-0513-D9A2"

## Bridge to Tai/Carrier411 (Future)

Not built now, but designed for:

- **Pull from Carrier411:** Richer compliance signals if API available (authority changes, FreightGuard flags)
- **Push to Tai:** Cleared dispatch package (driver/CDL/truck/VIN/insurance) as structured data that Tai can import
- **Avoid double entry:** If Kate already onboarded a carrier in Tai, CC should know and not re-ask for company-level docs

The bridge is future work. CC should be valuable without it. The wedge is the front door, not the integration.
