# SPINE-0002: Carrier Identity Spine

## Purpose

The carrier identity spine gives the system one durable way to recognize a carrier across load applications, profile submissions, and verification events.

## User Promise

The carrier should not have to reintroduce themselves every time. The broker should be able to see when a carrier is known, verified, stale, or risky.

## Core Decision

Use a canonical network-wide `carriers` identity record keyed by cleaned MC number.

`carrier_profiles`, `load_applications`, and `carrier_verifications` should reference carrier identity through `carrier_id`.

The `carriers` table belongs in the broker app database, which is the canonical system of record. Since the product is not live, do not preserve the current split where `load_applications` live in MCP and profiles/verifications live in the broker app.

## Proposed Table

```sql
CREATE TABLE IF NOT EXISTS carriers (
  id SERIAL PRIMARY KEY,
  mc_number TEXT UNIQUE NOT NULL,
  dot_number TEXT,
  fmcsa_legal_name TEXT,
  fmcsa_status TEXT,
  authority_status TEXT,
  safety_rating TEXT,
  phone TEXT,
  email TEXT,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  network_status TEXT NOT NULL DEFAULT 'known'
    CHECK (network_status IN ('known', 'profile_started', 'verified', 'stale', 'blocked')),
  latest_profile_id INTEGER,
  latest_verification_id INTEGER,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
```

## Required References

- `carrier_profiles.carrier_id`
- `load_applications.carrier_id`
- `carrier_verifications.carrier_id`

## System Of Record

Canonical carrier identity, profiles, load applications, and verifications should all live in the broker app database.

If MCP remains, it should call broker-app-owned APIs or database-backed services and store no canonical carrier identity. This keeps foreign keys real and prevents the system from replacing ad-hoc MC lookups with ad-hoc cross-service ID lookups.

## Utility

Every path should call one identity resolver:

```ts
findOrCreateCarrier(mcNumber)
```

Responsibilities:

- Clean MC number.
- Find existing carrier.
- Create carrier if missing.
- Update `last_seen_at`.
- Return `carrier_id`.

It should not run FMCSA by default. The calling path should write FMCSA data when it already performed a lookup.

## Network Status

- `known`: MC seen, no reusable profile yet
- `profile_started`: profile exists but is incomplete
- `verified`: current docs and active FMCSA state are present
- `stale`: previously verified, now expired or outdated
- `blocked`: manually blocked by operator

## Data Flow

Path A, load-first:

1. Carrier enters MC.
2. Resolve carrier identity.
3. Run FMCSA.
4. Create load application with `carrier_id`.
5. Update carrier contact data when interest is submitted.

Path B, broker-direct verification:

1. Verification trigger receives MC.
2. Resolve carrier identity.
3. Create verification with `carrier_id`.
4. Save docs/profile against the same identity.

Path C, carrier-direct profile:

1. Carrier enters MC.
2. Resolve carrier identity.
3. Save profile with `carrier_id`.
4. Update latest profile/status.

Path D, returning carrier:

1. Carrier enters MC anywhere.
2. Resolve identity.
3. Load current carrier/profile state.
4. Prefill known fields and ask only for missing or expired data.

## Must Never Happen

- A new profile is created without trying to resolve identity.
- A new load application is created without trying to resolve identity.
- A verification result is stored only against a token with no carrier identity.
- Network status is used as a broker-specific dispatch approval.

## Pilot Slice

Implement identity together with the broker-app-owned load application path. Then connect profile and verification. Avoid adding `carrier_id` to MCP-owned `load_applications` as the final model; that should only exist as a short-lived migration bridge if needed.
