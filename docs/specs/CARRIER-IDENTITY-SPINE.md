# Carrier Identity Spine

**Status:** Built — canonical carrier identity, driver/equipment records, and document records are implemented.
**Last updated:** May 19, 2026
**Canonical references:** `docs/spines/SPINE-0002-carrier-identity.md`, `docs/spines/SPINE-0010-carrier-master-record.md`

---

## Current Decision

Carrier identity is MC-level.

- `carriers` is the canonical identity record: one row per MC number.
- `carrier_drivers` stores reusable driver facts under a carrier.
- `carrier_equipment` stores reusable truck/trailer facts under a carrier.
- `carrier_documents` stores uploaded document records, parsed data, expiration, status, source, and supersession history.
- `canonical_load_applications` links a carrier to one load application.
- `load_assignments` links one load, applicant, carrier, and the confirmed driver/equipment package for that dispatch.

Driver/equipment selection is not Kate's normal job. Kate assigns the carrier/company. The carrier confirms the driver and truck for the load through `/confirm/:token`.

---

## Rules That Must Remain True

1. **Every write path resolves carrier identity first.** Use `findOrCreateCarrier()` for trusted write paths and read-only lookup helpers for GET/prefill paths.
2. **MC-only lookup may expose only public/company-level data.** Sensitive returning-carrier data such as phone, email, driver, truck, VIN, and document status requires a trusted token.
3. **Documents live in `carrier_documents`.** Driver/equipment rows store extracted current facts, not uploaded file ownership.
4. **Dispatch readiness is package-specific.** MC-level profile completeness is not enough once driver/equipment records exist.
5. **Network reuse requires consent.** Carrier-owned reusable data can speed future workflows only within consent boundaries.

---

## Historical Note

This file originally held the May 12 draft migration plan for introducing `carriers` and `carrier_id` foreign keys. That work is now complete. The long-form design has been folded into the spine docs:

- `SPINE-0002` for MC-level carrier identity.
- `SPINE-0010` for driver/equipment/document memory.
- `SPINE-0009` for per-load dispatch package confirmation.
