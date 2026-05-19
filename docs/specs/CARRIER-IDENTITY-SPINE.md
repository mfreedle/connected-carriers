# Carrier Identity Spine — Architecture Spec

**Status:** Draft — for review before implementation
**Date:** 2026-05-12
**Scope:** Canonical carrier identity model, table changes, entry path updates

---

## Problem

Connected Carriers has three carrier-related tables that don't share a common identity:

- `carrier_profiles` — keyed by email, mc_number not unique, multiple rows per carrier possible
- `load_applications` — keyed by mc_number per load, no FK to profiles
- `carrier_verifications` — keyed by token, has `carrier_profile_id` FK but no carrier identity FK

The only thing connecting a carrier across these tables is `mc_number`, resolved via ad-hoc `WHERE mc_number = $1 ORDER BY created_at DESC LIMIT 1` queries scattered across 5+ routes. This creates:

- Duplicate profile rows for the same carrier
- No way to say "this carrier has applied to 3 loads and was verified twice"
- No return-carrier recognition
- No profile freshness tracking at the network level
- Fragile joins that break when a carrier has multiple profiles

---

## Design Principles

1. **Every path starts by resolving carrier identity.** No path should casually create an orphan profile, orphan application, or orphan verification.
2. **A profile is versioned and mutable. Identity is stable.** The `carriers` table is small and durable. Profiles are document-heavy and change.
3. **Docs are network-reusable. Dispatch approval is contextual.** A carrier's CDL and insurance are the same regardless of which broker asks. But "Kate approved this carrier" or "CLEAR for load HX-0512-A3B7" is broker/load-specific.
4. **Carrier identity is not carrier login.** MC + phone/email magic links are enough for the pilot. No carrier accounts, no passwords.
5. **Consent before network reuse.** When profile data flows between broker contexts, the carrier should have agreed to it.

---

## Current Schema (as of 2026-05-12)

### carrier_profiles (broker app — app/src/db.ts)
```
id SERIAL PRIMARY KEY
company_name TEXT NOT NULL
mc_number TEXT                    -- NOT UNIQUE (bug)
contact_name TEXT NOT NULL
email TEXT NOT NULL
phone TEXT
driver_name, driver_phone, truck_number, trailer_number
equipment_types JSONB
lanes_or_regions TEXT
cdl_photo_url, vin_photo_url, insurance_doc_url (+ R2 keys)
vin_number, cdl_number, cdl_state, cdl_expiration, insurance_expiration
insurance_policy_number, insurance_company, insurance coverage fields
insurance_vins JSONB
parsed_cdl JSONB, parsed_insurance JSONB, parsed_vin TEXT
doc_flags JSONB
fmcsa_status, fmcsa_data JSONB, fmcsa_checked_at
completion_status: partial | complete | dispatch_ready
source: direct | superseded_nudge | broker_invite | interest_upgrade | site | load_apply | load_assign
created_at, updated_at
```

### carrier_verifications (broker app — app/src/db.ts)
```
id SERIAL PRIMARY KEY
token TEXT UNIQUE NOT NULL
broker_account_id → broker_accounts(id)
broker_name, broker_phone, broker_email
mc_number TEXT NOT NULL
carrier_phone, carrier_email, carrier_name
fmcsa_data JSONB, fmcsa_status
doc_cdl, doc_insurance, doc_cab_card, doc_truck_photo (R2 keys + timestamps)
driver_name, driver_phone, truck_vin, vin_decode JSONB
parsed_cdl JSONB, parsed_insurance JSONB, parsed_vin TEXT
cdl_expiration, insurance_expiration, insurance_company, insurance_policy_number
insurance_vins JSONB, cdl_name, cdl_number, cdl_state
doc_flags JSONB
carrier_profile_id INTEGER (nullable FK)
status: pending | in_progress | complete | expired
result: CLEAR | REVIEW | DO_NOT_DISPATCH
result_reasons JSONB
sms_sent_at, email_sent_at, reminder_count, etc.
created_at, updated_at
```

### load_applications (MCP server — mcp-server/src/db.ts)
```
id SERIAL PRIMARY KEY
load_id → loads(id)
mc_number TEXT NOT NULL
company_name, contact_name, contact_phone, contact_email
fmcsa_authority, fmcsa_safety, fmcsa_company
qualification_result: qualified | review | not_qualified
qualification_details JSONB
has_profile BOOLEAN
assigned_at TIMESTAMPTZ
verification_token TEXT
verification_result TEXT
verification_status TEXT
created_at
```

### loads (MCP server — mcp-server/src/db.ts)
```
id SERIAL PRIMARY KEY
load_id VARCHAR(30) UNIQUE
slug VARCHAR(20) UNIQUE
broker_account_id INTEGER
broker_name, broker_ref, broker_phone, broker_email
origin, destination, equipment, pickup_date
pickup_address, pickup_window
rate_note, notes
status: open | covered | cancelled
assigned_applicant_id → load_applications(id)
created_at
```

---

## Proposed Changes

### New table: `carriers`

The canonical network identity for a carrier, keyed on MC number.

```sql
CREATE TABLE IF NOT EXISTS carriers (
  id SERIAL PRIMARY KEY,
  mc_number TEXT UNIQUE NOT NULL,
  dot_number TEXT,
  fmcsa_legal_name TEXT,
  fmcsa_status TEXT,          -- from most recent FMCSA lookup
  authority_status TEXT,
  safety_rating TEXT,
  phone TEXT,                  -- best known contact phone
  email TEXT,                  -- best known contact email
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  network_status TEXT NOT NULL DEFAULT 'known'
    CHECK (network_status IN ('known', 'profile_started', 'verified', 'stale', 'blocked')),
  latest_profile_id INTEGER,  -- FK added after carrier_profiles update
  latest_verification_id INTEGER,  -- FK added after carrier_verifications update
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE UNIQUE INDEX idx_carriers_mc ON carriers(mc_number);
CREATE INDEX idx_carriers_status ON carriers(network_status);
```

**What it is:** Small, stable identity. One row per MC number forever.
**What it is not:** Not a profile. Not where docs live. Not broker-scoped.

### FK additions

```sql
ALTER TABLE carrier_profiles ADD COLUMN IF NOT EXISTS carrier_id INTEGER REFERENCES carriers(id);
CREATE INDEX IF NOT EXISTS idx_cp_carrier ON carrier_profiles(carrier_id);

ALTER TABLE load_applications ADD COLUMN IF NOT EXISTS carrier_id INTEGER REFERENCES carriers(id);
CREATE INDEX IF NOT EXISTS idx_la_carrier ON load_applications(carrier_id);

ALTER TABLE carrier_verifications ADD COLUMN IF NOT EXISTS carrier_id INTEGER REFERENCES carriers(id);
CREATE INDEX IF NOT EXISTS idx_cv_carrier ON carrier_verifications(carrier_id);
```

### Utility: `findOrCreateCarrier(mc_number)`

One function. Every entry path calls it. Returns the carrier ID.

```typescript
async function findOrCreateCarrier(mcNumber: string): Promise<{ id: number; isNew: boolean }> {
  const clean = mcNumber.replace(/\D/g, "");
  if (!clean) throw new Error("MC number required");

  // Try to find existing
  const existing = await query(
    "SELECT id FROM carriers WHERE mc_number = $1", [clean]
  );
  if (existing.rows.length) {
    await query(
      "UPDATE carriers SET last_seen_at = NOW(), updated_at = NOW() WHERE id = $1",
      [existing.rows[0].id]
    );
    return { id: existing.rows[0].id, isNew: false };
  }

  // Create new — FMCSA lookup happens at the call site, not here
  const result = await query(
    `INSERT INTO carriers (mc_number) VALUES ($1)
     ON CONFLICT (mc_number) DO UPDATE SET last_seen_at = NOW(), updated_at = NOW()
     RETURNING id`,
    [clean]
  );
  return { id: result.rows[0].id, isNew: true };
}
```

**Note:** `findOrCreateCarrier` does NOT run FMCSA. FMCSA data is written to the carrier by the calling path after lookup. This keeps the utility simple and avoids redundant lookups when FMCSA was already checked.

---

## Entry Path Updates

### Path A: Load-first (carrier clicks DAT link)

**Current:** MC check → creates `load_applications` row with mc_number. No carrier identity.

**Proposed:**
1. Carrier enters MC on load page
2. `findOrCreateCarrier(mc)` → get `carrier_id`
3. FMCSA check runs → update `carriers` with fmcsa_legal_name, fmcsa_status, authority_status, safety_rating
4. If carrier is known and has a profile: show "Welcome back, [company name]" and pre-fill contact fields
5. `load_applications.carrier_id` = carrier_id
6. After interest submission: update `carriers.phone`, `carriers.email` with latest contact info
7. Profile CTA: if carrier has no profile → "Submit docs now to get dispatched first." If carrier has a stale profile → "Update your docs to stay dispatch-ready."

### Path B: Broker-direct verify (assign triggers verify)

**Current:** Verify trigger creates `carrier_verifications` row with mc_number. Links to `carrier_profiles` by mc_number lookup.

**Proposed:**
1. Assign route calls verify trigger with mc_number
2. `findOrCreateCarrier(mc)` → get `carrier_id`
3. `carrier_verifications.carrier_id` = carrier_id
4. On doc submission: save to profile via `carrier_id`, update `carriers.latest_profile_id`
5. On result: update `carriers.latest_verification_id`, update `carriers.network_status` (verified / stale)

### Path C: Carrier-direct profile (carrier finds public site)

**Current:** Profile form creates `carrier_profiles` row. FMCSA check runs. No carrier identity.

**Proposed:**
1. Carrier enters MC on profile form
2. `findOrCreateCarrier(mc)` → get `carrier_id`
3. FMCSA check runs → update `carriers`
4. If existing profile: pre-fill form, show what's already on file
5. Profile saved with `carrier_profiles.carrier_id` = carrier_id
6. Update `carriers.latest_profile_id`, `carriers.network_status` = profile_started or verified

### Path D: Returning carrier (any entry point)

**Current:** No recognition. Carrier re-enters everything.

**Proposed:**
1. Carrier enters MC anywhere
2. `findOrCreateCarrier(mc)` returns existing carrier
3. System loads `carriers` + `carrier_profiles` (via `latest_profile_id`)
4. Pre-fills: company name, contact name, phone, email, driver info
5. Shows doc status: "CDL on file (expires Jan 2027)" / "Insurance expired — please re-upload"
6. Only asks for what's missing or expired

---

## Network Status Definitions

| Status | Meaning | How it's set |
|---|---|---|
| `known` | MC seen in system, no profile or docs | findOrCreateCarrier with no follow-up |
| `profile_started` | Carrier started a profile but it's incomplete | Profile saved with completion_status = partial |
| `verified` | Profile complete with current docs, FMCSA active | Profile dispatch_ready + FMCSA active + docs not expired |
| `stale` | Was verified, but docs have expired or FMCSA changed | Cron check or re-lookup found expired docs/inactive authority |
| `blocked` | Manually blocked by system operator | Admin action (future) |

Richer statuses (dispatch_ready for a specific broker, CLEAR on a specific load) are derived from `carrier_verifications` and `load_applications`, not stored on `carriers`.

---

## What This Does NOT Include

- **Carrier login / carrier portal.** Not needed for pilot. MC + magic link is enough.
- **Carrier status page post-submission.** Status pages must be token-gated. Do not expose profile or verification state at `/carrier/:mc/status`.
- **Broker-specific carrier notes / blacklist.** Important eventually, lives on a future `broker_carrier_notes` table, not on `carriers`.
- **Assignment as a first-class table.** Current representation (loads.assigned_applicant_id + load_applications.assigned_at) works for pilot. A `load_assignments` table may be needed later to support reassignment, multiple dispatch attempts, and audit trail.
- **Consent checkbox for network reuse.** Noted as required before network reuse is real. Add to profile form and load apply form: "Save my profile so brokers using Connected Carriers can qualify me faster."

---

## Data Migration

Existing `carrier_profiles`, `load_applications`, and `carrier_verifications` rows need backfill:

1. Extract unique mc_numbers from all three tables
2. Insert into `carriers` (ON CONFLICT skip)
3. Update `carrier_profiles.carrier_id`, `load_applications.carrier_id`, `carrier_verifications.carrier_id` by mc_number join
4. Set `carriers.latest_profile_id` from most recent `carrier_profiles` row per mc
5. Set `carriers.latest_verification_id` from most recent `carrier_verifications` row per mc
6. Set `carriers.network_status` based on profile completeness + FMCSA status

This can run as a one-time migration in the db init function.

---

## Build Order

1. **This spec** — review and approve before writing code
2. **carriers table + FKs + findOrCreateCarrier utility** — the foundation
3. **Data migration** — backfill existing rows
4. **Path A update** (load apply) — findOrCreateCarrier + return-carrier recognition
5. **Path C update** (profile submit) — findOrCreateCarrier + pre-fill from existing profile
6. **Path B update** (verify trigger) — findOrCreateCarrier + link verification to carrier
7. **Dashboard update** — applicant ranking pulls carrier history (profile status, last verified, loads applied to)
8. **Return-carrier pre-fill** — any entry point recognizes MC and shows known data
9. **Consent checkbox** — add to profile form and load apply form
10. **Then:** pilot test with Kate using a real carrier
