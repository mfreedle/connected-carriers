# SPINE-0003: Carrier Profile Spine

## Purpose

The carrier profile spine is the reusable document and operating profile for a carrier. It is not the carrier identity itself; it is the carrier's current dispatch-readiness package.

## User Promise

The carrier completes their profile once and gets dispatched faster on future loads. The broker benefits because clean carriers rise to the top and require less chasing.

## Trigger Paths

- Carrier clicks profile CTA after applying to a load.
- Carrier receives broker-direct verification or doc request.
- Carrier finds Connected Carriers directly and chooses to get verified.
- Carrier returns to update stale or expired docs.

## Data Stored

- Company/contact info
- Driver info
- Truck/trailer details
- Equipment types
- Lanes/regions
- CDL image and parsed fields
- Insurance document and parsed fields
- VIN/truck photo and parsed fields
- Insurance VINs
- Expiration dates
- FMCSA snapshot
- Completion status
- Consent for network reuse

## Completion Status

- `partial`: some information exists, but not dispatch-ready
- `docs_uploaded`: docs are present, OCR/checks may still be running
- `dispatch_ready`: required info and current docs are present
- `stale`: profile was ready but docs/FMCSA are outdated
- `flagged`: profile has document or authority flags

The exact stored values may stay compatible with the current database, but the UI should expose these meanings.

## UI Promise

The profile form should:

- Prefill MC and contact data from load application or carrier identity.
- Prefill company name from FMCSA when available.
- Show which docs are already on file.
- Ask only for missing or expired items when possible.
- Make the value clear: docs on file help the carrier get assigned faster.

## Consent

Before profile data is reused across broker contexts, the carrier should consent.

Suggested language:

> Save my carrier profile so brokers using Connected Carriers can qualify me faster.

Consent should be stored with timestamp and source.

## Failure States

- FMCSA lookup fails.
- Document upload fails.
- OCR fails or returns incomplete data.
- Insurance or CDL is expired.
- VIN does not match insurance.
- Carrier abandons form.

## Must Never Happen

- The carrier has to retype data already captured on the load page.
- A profile is treated as dispatch-ready before required checks complete.
- Expired docs appear as current.
- Broker-specific approval is stored as a network-wide profile fact.

## Current Gaps To Resolve

- Profiles are inserted as new rows rather than consistently linked to a canonical carrier identity.
- Latest profile lookup is ad hoc by MC or email.
- Background OCR can update status after confirmation, so the carrier may not know final readiness.
- Returning carrier prefill is not complete.
