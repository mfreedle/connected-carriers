# Insurance Waterfall Test Fixtures

Three known carrier fixtures that exercise the main evaluator branches deterministically.

## Fixtures

### MC 999001 — CLEAR (Signature Brand pattern)
- Scheduled Autos with VINs listed on cert
- Cab card VIN matches a VIN on the COI
- All coverage amounts above default thresholds ($1M auto, $100K cargo, $1M GL)
- Named insured matches FMCSA legal name
- CDL valid and current
- All confidence fields: high
- **Expected result: CLEAR**

### MC 999002 — NEEDS_DEC_PAGE (Phamile 1st pattern)
- Scheduled Autos but NO VINs on cert (empty array)
- Everything else valid — coverage, named insured, CDL, cab card
- **Expected result: REVIEW with "declarations page required" warning**
- After dec page upload (blanket): CLEAR
- After dec page upload (VIN match): CLEAR
- After dec page upload (VIN mismatch): REVIEW with VIN mismatch warning

Three dec page sub-fixtures are included:
- `dec_page_blanket` — blanket coverage, should resolve to CLEAR
- `dec_page_vin_match` — scheduled vehicles with matching VIN, should resolve to CLEAR
- `dec_page_vin_mismatch` — scheduled vehicles with non-matching VIN, should stay REVIEW

### MC 999003 — REVIEW / DO NOT DISPATCH (KIK pattern)
- Coverage type: unknown (could not determine)
- Auto liability: $750K (below $1M threshold)
- Cargo: $50K (below $100K threshold)
- General liability: missing
- CDL: expired (2025-01-15)
- Confidence: low on auto_liability and coverage type
- **Expected result: DO NOT DISPATCH** (expired CDL is a blocker)

## Usage

```bash
# Seed test carriers
cd app
npx ts-node test/fixtures/seed-test-carriers.ts
```

The seed script resets only the reserved test MCs (`999001`-`999003`) before inserting fresh fixture rows, so it is safe to re-run when repeating smoke tests.

After seeding, create a load in Kate's dashboard, have each test carrier apply via the load link, assign them, and confirm. The evaluator should return the expected result for each fixture.

## What Each Fixture Tests

| Branch | Fixture | Expected |
|--------|---------|----------|
| VIN match on COI | MC 999001 | CLEAR |
| Any Auto blanket | (modify 999001 fixture to `any_auto`) | CLEAR, skip VIN |
| Scheduled Autos + no VINs | MC 999002 | needs_dec_page |
| Dec page blanket resolution | MC 999002 + dec_page_blanket | CLEAR |
| Dec page VIN match | MC 999002 + dec_page_vin_match | CLEAR |
| Dec page VIN mismatch | MC 999002 + dec_page_vin_mismatch | REVIEW |
| Named insured mismatch | (modify any fixture) | REVIEW warning |
| Coverage below threshold | MC 999003 | REVIEW warning |
| Expired CDL | MC 999003 | DO NOT DISPATCH (blocker) |
| Low OCR confidence | MC 999003 | Additional REVIEW warnings |
| Missing coverage fields | MC 999003 (no GL) | REVIEW warning |
