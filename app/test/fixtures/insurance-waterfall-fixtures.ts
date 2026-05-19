/**
 * Insurance Verification Waterfall — Test Fixtures
 *
 * Three carrier scenarios that exercise the main evaluator branches:
 *
 * 1. CLEAR — Signature Brand pattern
 *    Scheduled Autos with VINs listed, all coverage above thresholds,
 *    named insured matches FMCSA, valid CDL, matching cab card VIN.
 *    Expected: CLEAR
 *
 * 2. NEEDS_DEC_PAGE — Phamile 1st pattern
 *    Scheduled Autos with NO VINs on cert, everything else valid.
 *    Expected: REVIEW with "declarations page required" warning.
 *    After dec page upload with matching VIN: CLEAR.
 *    After dec page upload with blanket coverage: CLEAR.
 *
 * 3. REVIEW (low confidence / weak data) — Bad cert pattern
 *    Low confidence on critical fields, coverage below thresholds,
 *    named insured mismatch, expired CDL.
 *    Expected: multiple warnings → REVIEW or DO_NOT_DISPATCH.
 *
 * Usage:
 *   cd app && npx ts-node test/fixtures/seed-test-carriers.ts
 *
 * Prerequisites:
 *   - Database connection via DATABASE_URL
 *   - At least one broker_account (uses broker_account_id = 1 by default)
 */

// ── Fixture 1: CLEAR carrier ─────────────────────────────────────

export const CLEAR_CARRIER = {
  mc_number: "999001",
  fmcsa_legal_name: "SIGNATURE BRAND LOGISTICS LLC",
  fmcsa_status_text: "ACTIVE",
  authority_status: "AUTHORIZED FOR Property",

  driver: {
    driver_name: "John Martinez",
    driver_phone: "+15551110001",
    cdl_number: "M12345678",
    cdl_expiration: "2027-09-15",
    status: "active",
  },

  equipment: {
    truck_number: "T-101",
    vin_number: "3AKJHHDR0JSJX2126",
    trailer_number: "TR-201",
    status: "active",
  },

  cdl_parsed_data: {
    driver_name: "John Martinez",
    cdl_number: "M12345678",
    state: "MA",
    expiration_date: "2027-09-15",
    class: "A",
  },

  cab_card_parsed_data: {
    vin: "3AKJHHDR0JSJX2126",
  },

  insurance_parsed_data: {
    policy_number: "FLBSIC-1611-00816",
    insurance_company: "Commerce Ins Co",
    expiration_date: "2027-01-12",
    named_insured: "SIGNATURE BRAND LOGISTICS LLC",
    auto_liability: 1000000,
    cargo: 150000,
    general_liability: 1000000,
    auto_coverage_type: "scheduled_autos" as const,
    vins: ["3AKJHHDR0JSJX2126", "1GRAA0620BD439761"],
    confidence: {
      expiration_date: "high" as const,
      auto_liability: "high" as const,
      vins: "high" as const,
      named_insured: "high" as const,
      auto_coverage_type: "high" as const,
    },
  },
};

// ── Fixture 2: NEEDS_DEC_PAGE carrier ────────────────────────────

export const NEEDS_DEC_PAGE_CARRIER = {
  mc_number: "999002",
  fmcsa_legal_name: "PHAMILE 1ST LLC",
  fmcsa_status_text: "ACTIVE",
  authority_status: "AUTHORIZED FOR Property",

  driver: {
    driver_name: "David Chen",
    driver_phone: "+15551110002",
    cdl_number: "C98765432",
    cdl_expiration: "2027-06-30",
    status: "active",
  },

  equipment: {
    truck_number: "T-202",
    vin_number: "1FUJHHDR5CLBX9999",
    trailer_number: "TR-302",
    status: "active",
  },

  cdl_parsed_data: {
    driver_name: "David Chen",
    cdl_number: "C98765432",
    state: "TX",
    expiration_date: "2027-06-30",
    class: "A",
  },

  cab_card_parsed_data: {
    vin: "1FUJHHDR5CLBX9999",
  },

  insurance_parsed_data: {
    policy_number: "FLBSIC-2024-44321",
    insurance_company: "Benchmark Insurance Company",
    expiration_date: "2027-02-21",
    named_insured: "PHAMILE 1ST LLC",
    auto_liability: 1000000,
    cargo: 100000,
    general_liability: 1000000,
    auto_coverage_type: "scheduled_autos" as const,
    vins: [],  // No VINs on cert — triggers dec page request
    confidence: {
      expiration_date: "high" as const,
      auto_liability: "high" as const,
      vins: "high" as const,  // high because we confidently found zero VINs
      named_insured: "high" as const,
      auto_coverage_type: "high" as const,
    },
  },

  // Dec page fixture: blanket coverage resolution
  dec_page_blanket: {
    coverage_type: "blanket" as const,
    vins: [],
    policy_number: "FLBSIC-2024-44321",
    named_insured: "PHAMILE 1ST LLC",
    expiration_date: "2027-02-21",
    confidence: {
      coverage_type: "high" as const,
      vins: "high" as const,
    },
  },

  // Dec page fixture: scheduled vehicles with matching VIN
  dec_page_vin_match: {
    coverage_type: "scheduled_vehicles" as const,
    vins: ["1FUJHHDR5CLBX9999", "2HSFHHDR7DLCX8888"],
    policy_number: "FLBSIC-2024-44321",
    named_insured: "PHAMILE 1ST LLC",
    expiration_date: "2027-02-21",
    confidence: {
      coverage_type: "high" as const,
      vins: "high" as const,
    },
  },

  // Dec page fixture: scheduled vehicles with NON-matching VIN
  dec_page_vin_mismatch: {
    coverage_type: "scheduled_vehicles" as const,
    vins: ["9XYZHHDR0ABCD1234", "2HSFHHDR7DLCX8888"],
    policy_number: "FLBSIC-2024-44321",
    named_insured: "PHAMILE 1ST LLC",
    expiration_date: "2027-02-21",
    confidence: {
      coverage_type: "high" as const,
      vins: "high" as const,
    },
  },
};

// ── Fixture 3: REVIEW / weak data carrier ────────────────────────

export const REVIEW_CARRIER = {
  mc_number: "999003",
  fmcsa_legal_name: "KIK LLC",
  fmcsa_status_text: "ACTIVE",
  authority_status: "AUTHORIZED FOR Property",

  driver: {
    driver_name: "Mike Thompson",
    driver_phone: "+15551110003",
    cdl_number: "K55544433",
    cdl_expiration: "2025-01-15",  // EXPIRED
    status: "active",
  },

  equipment: {
    truck_number: "T-303",
    vin_number: "3AKJHHDRXNSNH6763",
    trailer_number: null,
    status: "active",
  },

  cdl_parsed_data: {
    driver_name: "Mike Thompson",
    cdl_number: "K55544433",
    state: "IL",
    expiration_date: "2025-01-15",  // EXPIRED — should be blocker
    class: "A",
  },

  cab_card_parsed_data: {
    vin: "3AKJHHDRXNSNH6763",
  },

  insurance_parsed_data: {
    policy_number: "FBCAT0642100",
    insurance_company: "Arch Insurance Company",
    expiration_date: "2026-06-26",
    named_insured: "KIK LLC",
    certificate_holder: "LOGISTICS XPRESS LLC",
    auto_liability: 750000,  // Below default $1M threshold
    cargo: 50000,  // Below default $100K threshold
    general_liability: null,  // Missing
    auto_coverage_type: "unknown" as const,  // Could not determine
    vins: ["3AKJHHDRXNSNH6763"],
    confidence: {
      expiration_date: "medium" as const,
      auto_liability: "low" as const,
      vins: "medium" as const,
      named_insured: "high" as const,
      auto_coverage_type: "low" as const,
    },
  },
};
