/**
 * FMCSA SAFER lookup — canonical implementation.
 *
 * One module, used by:
 *   - services/verification.ts (verify trigger)
 *   - routes/verify.ts (other verify page helpers)
 *   - routes/canonical-loads.ts (load apply MC check)
 *   - routes/profile.ts (profile FMCSA check)
 */

export interface FMCSAResult {
  mc_number: string;
  found: boolean;
  entity_name?: string | null;
  legal_name?: string | null;
  dba_name?: string | null;
  dot_number?: string | null;
  usdot_number?: string | null;
  usdot_status?: string | null;
  operating_status?: string | null;
  entity_type?: string | null;
  physical_address?: string | null;
  phone?: string | null;
  mailing_address?: string | null;
  power_units?: string | null;
  drivers?: string | null;
  safety_rating?: string | null;
  insurance_bipd?: string | null;
  source?: string;
  checked_at?: string;
  active?: boolean;
  authorized?: boolean;
  raw?: Record<string, string>;
}

/**
 * Parse FMCSA SAFER HTML response into structured data.
 */
export function parseFMCSAHtml(html: string, mc: string): FMCSAResult {
  if (html.includes("No records found") || html.includes("no records found")) {
    return { mc_number: mc, found: false, active: false, source: "FMCSA SAFER" };
  }

  const rowData: Record<string, string> = {};
  const trPattern = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let trMatch: RegExpExecArray | null;
  while ((trMatch = trPattern.exec(html)) !== null) {
    const cells: string[] = [];
    const tdPattern = /<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi;
    let tdMatch: RegExpExecArray | null;
    while ((tdMatch = tdPattern.exec(trMatch[1])) !== null) {
      const text = tdMatch[1]
        .replace(/<[^>]+>/g, " ")
        .replace(/&nbsp;|&#160;/g, " ")
        .replace(/&amp;/g, "&")
        .replace(/\s+/g, " ")
        .trim();
      if (text) cells.push(text);
    }
    for (let i = 0; i < cells.length - 1; i += 2) {
      const label = cells[i].replace(/:?\s*$/, "").trim();
      const value = cells[i + 1].trim();
      if (label && value) rowData[label] = value;
    }
  }

  const usdotStatus = rowData["USDOT Status"] || "";
  const operatingStatus = rowData["Operating Authority Status"] || "";
  const entityName = rowData["Legal Name"] || rowData["Entity"] || null;

  return {
    mc_number: mc,
    found: true,
    entity_name: entityName,
    legal_name: entityName,
    dba_name: rowData["DBA Name"] || null,
    dot_number: rowData["USDOT Number"] || null,
    usdot_number: rowData["USDOT Number"] || null,
    usdot_status: usdotStatus || null,
    operating_status: operatingStatus || null,
    entity_type: rowData["Entity Type"] || rowData["Carrier Operation"] || null,
    physical_address: rowData["Physical Address"] || null,
    phone: rowData["Phone"] || null,
    mailing_address: rowData["Mailing Address"] || null,
    power_units: rowData["Power Units"] || null,
    drivers: rowData["Drivers"] || null,
    safety_rating: rowData["Rating"] || rowData["Safety Rating"] || "Not Rated",
    insurance_bipd: rowData["BIPD/Primary"] || rowData["Required"] || null,
    source: "FMCSA SAFER",
    checked_at: new Date().toISOString(),
    active: usdotStatus.toUpperCase() === "ACTIVE",
    authorized: operatingStatus.toUpperCase().includes("AUTHORIZED"),
    raw: rowData,
  };
}

/**
 * Fetch + parse FMCSA SAFER data for an MC number.
 */
export async function lookupFMCSA(mc: string): Promise<FMCSAResult> {
  const clean = mc.replace(/\D/g, "");
  const url = `https://safer.fmcsa.dot.gov/query.asp?searchtype=ANY&query_type=queryCarrierSnapshot&query_param=MC_MX&query_string=${clean}&action=get_data`;
  const resp = await fetch(url, { signal: AbortSignal.timeout(10000) });
  if (!resp.ok) throw new Error(`FMCSA returned ${resp.status}`);
  const html = await resp.text();
  return parseFMCSAHtml(html, clean);
}
