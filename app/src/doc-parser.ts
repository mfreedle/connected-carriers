// Document parser using Claude Vision API
// Extracts structured data from CDL photos, COI documents, and VIN photos

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";

interface ParsedCDL {
  driver_name?: string;
  cdl_number?: string;
  state?: string;
  expiration_date?: string; // YYYY-MM-DD
  class?: string;
  endorsements?: string;
}

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
      model: "claude-sonnet-4-20250514",
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
  const system = "You extract structured data from Certificate of Insurance (COI / ACORD 25) documents. Return ONLY valid JSON with no other text.";
  const prompt = `Extract the following fields from this insurance certificate. Return JSON only, no explanation:
{
  "policy_number": "the policy number",
  "insurance_company": "name of the insurance company",
  "expiration_date": "YYYY-MM-DD format — use the policy expiration date, not the certificate date",
  "named_insured": "the named insured on the policy",
  "certificate_holder": "the certificate holder name if listed",
  "auto_liability": dollar amount as integer (e.g. 1000000 for $1M),
  "cargo": dollar amount as integer,
  "general_liability": dollar amount as integer,
  "vins": ["list", "of", "VIN", "numbers", "found", "on", "the", "document"]
}
For dollar amounts, convert to integers (e.g. $1,000,000 = 1000000).
If a field is not visible or readable, omit it from the JSON.
Look carefully for VIN numbers — they are 17-character alphanumeric codes, often listed in a vehicle schedule or on the policy declarations page.`;

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
