// Document parser using Claude Vision API
// Extracts structured data from CDL photos, COI documents, and VIN photos

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-4-6";
const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";

interface ParsedCDL {
  driver_name?: string;
  cdl_number?: string;
  state?: string;
  expiration_date?: string; // YYYY-MM-DD
  class?: string;
  endorsements?: string;
}

type AutoCoverageType =
  | "any_auto"
  | "scheduled_autos"
  | "owned_autos"
  | "hired_autos"
  | "non_owned_autos"
  | "hired_and_non_owned_autos"
  | "unknown";

type ConfidenceLevel = "high" | "medium" | "low";

interface ParsedInsurance {
  policy_number?: string;
  insurance_company?: string;
  expiration_date?: string; // YYYY-MM-DD
  named_insured?: string;
  certificate_holder?: string;
  auto_liability?: number;
  cargo?: number;
  general_liability?: number;
  vins?: string[];
  auto_coverage_type?: AutoCoverageType;
  confidence?: {
    expiration_date?: ConfidenceLevel;
    auto_liability?: ConfidenceLevel;
    vins?: ConfidenceLevel;
    named_insured?: ConfidenceLevel;
    auto_coverage_type?: ConfidenceLevel;
  };
}

interface ParsedVIN {
  vin?: string; // 17-character VIN
}

async function callClaude(systemPrompt: string, imageUrl: string, userPrompt: string): Promise<string> {
  if (!ANTHROPIC_API_KEY) {
    console.log("[DocParser] No ANTHROPIC_API_KEY — skipping AI parsing");
    return "{}";
  }

  try {
    // Fetch the image and convert to base64
    const imgResp = await fetch(imageUrl);
    if (!imgResp.ok) throw new Error(`Failed to fetch image: ${imgResp.status}`);
    const imgBuffer = await imgResp.arrayBuffer();
    const base64 = Buffer.from(imgBuffer).toString("base64");

    // Detect media type
    const contentType = imgResp.headers.get("content-type") || "image/jpeg";
    const mediaType = contentType.includes("pdf") ? "application/pdf" : contentType.includes("png") ? "image/png" : "image/jpeg";

    const body: any = {
      model: ANTHROPIC_MODEL,
      max_tokens: 1000,
      system: systemPrompt,
      messages: [{
        role: "user",
        content: [
          {
            type: mediaType === "application/pdf" ? "document" : "image",
            source: { type: "base64", media_type: mediaType, data: base64 }
          },
          { type: "text", text: userPrompt }
        ]
      }]
    };

    const resp = await fetch(ANTHROPIC_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify(body)
    });

    if (!resp.ok) {
      const errText = await resp.text();
      console.error("[DocParser] API error:", resp.status, errText);
      return "{}";
    }

    const data: any = await resp.json();
    const text = data.content?.find((c: any) => c.type === "text")?.text || "{}";
    // Strip any markdown code fences
    return text.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
  } catch (err) {
    console.error("[DocParser] Error:", err);
    return "{}";
  }
}

export async function parseCDL(imageUrl: string): Promise<ParsedCDL> {
  const system = "You extract structured data from Commercial Driver's License (CDL) photos. Return ONLY valid JSON with no other text.";
  const prompt = `Extract the following fields from this CDL photo. Return JSON only, no explanation:
{
  "driver_name": "full name as shown",
  "cdl_number": "the license number",
  "state": "issuing state abbreviation",
  "expiration_date": "YYYY-MM-DD format",
  "class": "license class (A, B, C)",
  "endorsements": "any endorsements listed"
}
If a field is not visible or readable, omit it from the JSON.`;

  const raw = await callClaude(system, imageUrl, prompt);
  try { return JSON.parse(raw); } catch { return {}; }
}

export async function parseInsurance(imageUrl: string): Promise<ParsedInsurance> {
  const system = `You extract structured data from Certificate of Insurance (COI / ACORD 25) documents. Return ONLY valid JSON with no other text.

IMPORTANT: Examine ALL pages of the document, including any ACORD 101 Additional Remarks Schedule pages. VINs and vehicle details often appear on page 2 or later, not on page 1.`;

  const prompt = `Extract the following fields from this insurance certificate. Return JSON only, no explanation:
{
  "policy_number": "the auto liability policy number",
  "insurance_company": "name of the auto liability insurance company",
  "expiration_date": "YYYY-MM-DD format — use the auto liability policy expiration date, not the certificate date",
  "named_insured": "the named insured / insured entity on the policy — exactly as printed",
  "certificate_holder": "the certificate holder name if listed",
  "auto_liability": dollar amount as integer (e.g. 1000000 for $1M) — use the Combined Single Limit (Ea accident) amount,
  "cargo": dollar amount as integer — from Motor Truck Cargo limit if present,
  "general_liability": dollar amount as integer — use the Each Occurrence amount,
  "vins": ["list of all VIN numbers found anywhere in the document, including remarks pages"],
  "auto_coverage_type": "Check the AUTOMOBILE LIABILITY section checkboxes:
    - If 'ANY AUTO' is checked → 'any_auto'
    - If 'SCHEDULED AUTOS' is checked (alone or with HIRED/NON-OWNED) → 'scheduled_autos'
    - If 'OWNED AUTOS ONLY' is checked → 'owned_autos'
    - If both 'HIRED AUTOS ONLY' and 'NON-OWNED AUTOS ONLY' are checked (without ANY AUTO or SCHEDULED) → 'hired_and_non_owned_autos'
    - If only 'HIRED AUTOS ONLY' is checked → 'hired_autos'
    - If only 'NON-OWNED AUTOS ONLY' is checked → 'non_owned_autos'
    - If you cannot determine which boxes are checked → 'unknown'",
  "confidence": {
    "expiration_date": "high if the date is clearly printed and unambiguous, medium if partially obscured or you had to infer, low if you are guessing",
    "auto_liability": "high if the dollar amount is clearly printed, medium if partially readable, low if guessing",
    "vins": "high if VINs are clearly readable 17-character codes, medium if partially obscured, low if guessing. Use high if no VINs exist on the document and you are returning an empty array",
    "named_insured": "high if clearly readable, medium if partially obscured, low if guessing",
    "auto_coverage_type": "high if the checkbox is clearly marked, medium if the mark is ambiguous, low if guessing"
  }
}
For dollar amounts, convert to integers (e.g. $1,000,000 = 1000000).
If a field is not visible or readable, omit it from the JSON (but still include its confidence as "low" if you attempted to read it).
Look carefully for VIN numbers — they are 17-character alphanumeric codes. Check the Description of Operations section, any ACORD 101 Additional Remarks pages, and any vehicle schedules. If no VINs are found anywhere, return an empty array.`;

  const raw = await callClaude(system, imageUrl, prompt);
  try { return JSON.parse(raw); } catch { return {}; }
}

export async function parseVINPhoto(imageUrl: string): Promise<ParsedVIN> {
  const system = "You extract Vehicle Identification Numbers (VINs) from photos of truck door plates, registration documents, or VIN stickers. Return ONLY valid JSON with no other text.";
  const prompt = `Extract the VIN number from this photo. Return JSON only, no explanation:
{
  "vin": "the 17-character VIN number"
}
VINs are exactly 17 characters long, containing letters (except I, O, Q) and numbers.
If you cannot read the VIN clearly, return {}.`;

  const raw = await callClaude(system, imageUrl, prompt);
  try { return JSON.parse(raw); } catch { return {}; }
}

export function checkDocFlags(profile: any): string[] {
  const flags: string[] = [];
  const today = new Date();
  const thirtyDays = new Date(today.getTime() + 30 * 24 * 60 * 60 * 1000);
  const sevenDays = new Date(today.getTime() + 7 * 24 * 60 * 60 * 1000);

  // Insurance expiration checks
  if (profile.insurance_expiration) {
    const expDate = new Date(profile.insurance_expiration);
    if (expDate < today) {
      flags.push("INSURANCE_EXPIRED");
    } else if (expDate < sevenDays) {
      flags.push("INSURANCE_EXPIRING_7_DAYS");
    } else if (expDate < thirtyDays) {
      flags.push("INSURANCE_EXPIRING_30_DAYS");
    }
  }

  // CDL expiration checks
  if (profile.cdl_expiration) {
    const expDate = new Date(profile.cdl_expiration);
    if (expDate < today) {
      flags.push("CDL_EXPIRED");
    } else if (expDate < thirtyDays) {
      flags.push("CDL_EXPIRING_30_DAYS");
    }
  }

  // VIN cross-reference
  if (profile.vin_number && profile.insurance_vins && Array.isArray(profile.insurance_vins) && profile.insurance_vins.length > 0) {
    const vinClean = profile.vin_number.replace(/\s/g, "").toUpperCase();
    const insVins = profile.insurance_vins.map((v: string) => v.replace(/\s/g, "").toUpperCase());
    if (!insVins.includes(vinClean)) {
      flags.push("VIN_NOT_ON_INSURANCE");
    }
  }

  // Missing docs
  if (!profile.cdl_photo_url) flags.push("MISSING_CDL");
  if (!profile.vin_photo_url) flags.push("MISSING_VIN_PHOTO");
  if (!profile.insurance_doc_url) flags.push("MISSING_INSURANCE");
  if (!profile.vin_number) flags.push("MISSING_VIN_NUMBER");
  if (!profile.driver_name) flags.push("MISSING_DRIVER_NAME");
  if (!profile.driver_phone) flags.push("MISSING_DRIVER_PHONE");
  if (!profile.truck_number) flags.push("MISSING_TRUCK_NUMBER");

  return flags;
}
