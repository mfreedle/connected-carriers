# SPINE-0009: Dispatch Package

**Status:** Partially built — carrier/company level works, driver/equipment level not yet modeled
**Owner:** Broker app
**Core question this answers for Kate:** "Is this specific driver with this specific truck ready to pick up this load?"

---

## The Problem

Kate chose a carrier from her applicants. But "carrier qualified" is not "dispatch ready." The carrier is an MC number — a company. The driver showing up at the dock is a person with a CDL, driving a specific truck with a specific VIN, pulling a specific trailer. None of that is confirmed yet.

Carrier411 tells Kate the company is safe. Tai will manage the carrier in her TMS. But neither confirms: "John Smith with CDL #X driving truck VIN Y is ready for THIS load."

## What CC Owns

The per-load dispatch package: the specific driver, truck, trailer, and documents that apply to this pickup.

**Kate assigns the carrier. The carrier confirms the driver and equipment. CC verifies the dispatch package.**

Kate should not normally choose the driver or truck. She chooses the carrier/company. The carrier confirms which driver and equipment are actually taking the load. Kate only sees the resulting decision and any plain-language exceptions.

## Flow

1. Kate clicks "Assign Carrier" on her dashboard
2. System checks: does this carrier have a current dispatch package for this load?
   - **Yes (fast path):** Selected driver/truck/docs are on file and current → arrival signal sent immediately
   - **No (chase path):** Carrier gets SMS/email with a magic link to confirm or update the package
3. Carrier clicks the link and confirms or provides:
   - Driver name + phone
   - CDL (photo upload if not on file)
   - Truck number + VIN
   - Trailer number
   - Cab card / truck photo
   - Insurance COI (if not on file or expired)
4. System verifies:
   - CDL expiration (not expired)
   - Insurance expiration (not expired)
   - VIN on cab card matches VIN on insurance policy
   - FMCSA authority still active (re-check)
5. Kate gets one signal: **CLEAR** / **CAUTION** / **DO NOT USE**
6. If CLEAR: arrival check SMS sent to driver with pickup geofence

## Current State vs Target

### What's built (carrier/company level)
- `carrier_profiles` stores CDL, insurance, cab card, VIN, driver info
- `carrier_verifications` runs per-broker, per-load verification
- `triggerCarrierVerification()` sends carrier the magic link
- OCR parses CDL, insurance, VIN photos
- Doc flags check VIN match, expirations
- Result delivered to broker: CLEAR / CAUTION / DO NOT USE

### What's NOT built (driver/equipment level)
- No `carrier_drivers` table — driver info lives on the profile, one driver per MC
- No `carrier_equipment` table — truck/trailer lives on the profile, one set per MC
- Same MC with a different driver or truck reuses the same profile
- No way to say "MC#70000 has 3 drivers and 5 trucks, which one is on this load?"

## Target Data Model

```
carrier_drivers
  id
  carrier_id → carriers
  driver_name
  driver_phone
  cdl_number
  cdl_state
  cdl_expiration
  status: active | inactive | expired
  created_at, updated_at

carrier_equipment
  id
  carrier_id → carriers
  truck_number
  vin_number
  trailer_number
  cab_card_r2_key
  equipment_type (53' Dry Van, Reefer, Flatbed, etc.)
  status: active | inactive
  created_at, updated_at

carrier_documents
  id
  carrier_id → carriers
  driver_id → carrier_drivers (nullable)
  equipment_id → carrier_equipment (nullable)
  doc_type: cdl | insurance | cab_card | truck_photo | w9
  r2_key
  display_url or signed-url metadata (if needed)
  parsed_data JSONB
  expiration_date
  status: current | expiring | expired | superseded
  created_at, updated_at
```

## Document Ownership Rule

Do not store uploaded document files directly "in" the driver or equipment row as the canonical source. Store document metadata and the R2 key in `carrier_documents`, then link it to the thing it proves.

- CDL document → `carrier_documents.driver_id`
- CDL number/state/expiration extracted from that document → `carrier_drivers`
- Cab card / truck photo → `carrier_documents.equipment_id`
- VIN extracted from cab card/photo → `carrier_equipment`
- Insurance COI → `carrier_documents.carrier_id`, with VIN coverage details linked or derived for equipment checks

This keeps driver and equipment rows small and durable, while document records can be superseded, expire, or be re-OCR'd without rewriting identity records.

## Assignment Flow (Target)

```
Kate assigns carrier (MC level)
  → System sends carrier confirmation link
  → Carrier selects or adds driver for this load
  → Carrier selects or adds truck/trailer for this load
  → System checks: are this driver's CDL and this truck's docs current?
    → All current: CLEAR → arrival signal
    → Missing/stale: upload only what's needed (not everything from scratch)
    → Failed: CAUTION or DO NOT USE with specific flags
```

## Design Rules

- The dispatch package is per-load, not per-carrier
- Same MC, different driver = different dispatch package
- Carriers should never re-upload docs that are already current
- The system should know what's missing and ask only for that
- "Dispatch ready" means: this driver, this truck, this load — not just "this MC has docs"
- Kate sees the dispatch package status, not raw doc data
- Driver/equipment selection belongs to the carrier confirmation flow; broker override is an exception path, not the default.
