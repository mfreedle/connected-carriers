# SPINE-0005: Verification and Document Chase Spine

## Purpose

The verification chase spine handles document collection, OCR, rule checks, and the CLEAR / CAUTION / DO NOT USE result.

## User Promise

The broker should not manually chase CDL, insurance, cab card, or truck photos. The system should ask the carrier, read the docs, and report the decision clearly.

## Trigger Paths

- Broker-direct intake.
- Assignment of a carrier without current reusable profile.
- Manual broker request, future.

## Data Created

- `carrier_verifications`
- Uploaded document files and keys
- OCR parsed fields
- Result reasons
- Link to carrier identity and profile
- Link to broker/load/assignment context

## Required Flow

1. System creates verification request.
2. Carrier receives SMS magic link.
3. Carrier uploads required docs.
4. OCR parses docs.
5. Rule checks run.
6. Result is set to CLEAR, CAUTION, or DO_NOT_USE.
7. Broker receives notification.
8. Reusable profile data is updated when consent and data quality allow.

## Result Model

- `CLEAR`: no blocking flags; dispatch can continue.
- `CAUTION`: carrier may be usable, but broker must review flags.
- `DO_NOT_USE`: hard stop.

Result reasons should be structured and readable.

Examples:

- FMCSA inactive
- authority not authorized
- insurance expired
- CDL expired
- VIN not found on insurance
- missing document
- OCR uncertain

## UI Promise

For the broker:

- Show result next to the load/assignment.
- Show concise reasons.
- Provide report link when available.
- Do not hide failed trigger states.

For the carrier:

- Make upload requirements clear.
- Avoid asking for docs already on file and current.
- Show that submission is tied to getting dispatched faster.

## Failure States

- SMS fails.
- Carrier opens expired token.
- Carrier abandons upload.
- OCR fails.
- Required doc missing.
- Verification trigger fails.

## Must Never Happen

- Failed verification trigger is treated as success.
- Verification result is saved only to a carrier without load/assignment context.
- A CAUTION or DO_NOT_USE result is displayed as clear.
- Reusable profile is updated with untrusted or incomplete parsed data without flags.

## Current Gaps To Resolve

- Verification is linked to assignment indirectly through token/status fields.
- Fallback profile SMS should remain visible to broker as a degraded state.
- Carrier identity should be attached to every verification.
