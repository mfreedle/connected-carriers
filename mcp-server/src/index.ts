import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import http from "http";
import crypto from "crypto";
import { query, initDb } from "./db.js";

// ── ENV ─────────────────────────────────────────────────────────
const TWILIO_ACCOUNT_SID  = process.env.TWILIO_ACCOUNT_SID  || "";
const TWILIO_AUTH_TOKEN   = process.env.TWILIO_AUTH_TOKEN   || "";
const TWILIO_PHONE_NUMBER = process.env.TWILIO_PHONE_NUMBER || "";
const GOOGLE_GEOCODE_KEY  = process.env.GOOGLE_GEOCODE_KEY  || "";
const BASE_URL            = process.env.BASE_URL || "https://cc-mcp-server-production.up.railway.app";

// ── MCP SERVER FACTORY ───────────────────────────────────────────
// Returns a fresh McpServer with all tools registered.
// Called per-request so each request gets its own isolated instance
// (required by SDK 1.29.0 — a shared transport crashes on second request).
function buildMcpServer(): McpServer {
  const mcpServer = new McpServer({
    name: "cc-mcp-server",
    version: "1.2.0"
  });

  // ── TOOL: cc_lookup_carrier
  mcpServer.registerTool(
    "cc_lookup_carrier",
    {
      description: "Look up a carrier by MC number against FMCSA SAFER API. Returns authority status, safety rating, insurance on file, and years in operation.",
      inputSchema: {
        mc_number: z.string().describe("The carrier MC number (without 'MC' prefix, just digits)")
      }
    },
    async ({ mc_number }) => {
      try {
        const result = await lookupFMCSA(mc_number);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      } catch (error) {
        return { content: [{ type: "text", text: `Error looking up MC${mc_number}: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
      }
    }
  );

  // ── TOOL: cc_verify_carrier
  mcpServer.registerTool(
    "cc_verify_carrier",
    {
      description: "Run full verification on a carrier submission. Checks FMCSA authority, safety rating, insurance minimums, and years in operation against broker requirements.",
      inputSchema: {
        mc_number: z.string().describe("Carrier MC number"),
        dot_number: z.string().optional().describe("Carrier DOT number"),
        min_insurance: z.number().optional().describe("Minimum auto liability insurance required in dollars"),
        min_years: z.number().optional().describe("Minimum years in business required")
      }
    },
    async ({ mc_number, min_insurance, min_years }) => {
      try {
        const fmcsa = await lookupFMCSA(mc_number);
        const checks = runVerificationChecks(fmcsa, { min_insurance, min_years });
        return { content: [{ type: "text", text: JSON.stringify({ mc_number, fmcsa, checks }, null, 2) }] };
      } catch (error) {
        return { content: [{ type: "text", text: `Verification error for MC${mc_number}: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
      }
    }
  );

  // ── TOOL: cc_assign_tier
  mcpServer.registerTool(
    "cc_assign_tier",
    {
      description: "Assign a carrier tier (1-Preferred, 2-Approved, 3-Conditional, Rejected) based on verification results and broker history.",
      inputSchema: {
        mc_number: z.string(),
        in_port_tms: z.boolean(),
        completed_loads: z.number(),
        verification_passed: z.boolean(),
        has_safety_flag: z.boolean(),
        failed_hard_stop: z.boolean()
      }
    },
    async ({ mc_number, in_port_tms, completed_loads, verification_passed, has_safety_flag, failed_hard_stop }) => {
      let tier: string;
      let reason: string;
      if (failed_hard_stop) {
        tier = "Rejected"; reason = "Failed one or more automatic disqualifiers";
      } else if (in_port_tms && completed_loads >= 3 && verification_passed && !has_safety_flag) {
        tier = "Tier 1 — Preferred"; reason = "In Port TMS with 3+ loads and clean history";
      } else if (verification_passed && !has_safety_flag) {
        tier = "Tier 2 — Approved"; reason = "New carrier, passes all hard stops";
      } else {
        tier = "Tier 3 — Conditional"; reason = "Passes minimums, manual review required";
      }
      return { content: [{ type: "text", text: JSON.stringify({ mc_number, tier, reason }, null, 2) }] };
    }
  );

  return mcpServer;
}

// ── FMCSA SAFER API ─────────────────────────────────────────────
// Parses the FMCSA SAFER HTML table structure.
// Key row patterns observed:
//   ['Legal Name:', 'ACME TRUCKING LLC']
//   ['USDOT Status:', 'ACTIVE', 'Out of Service Date:', 'None']
//   ['Rating Date:', 'None', 'Review Date:', 'None']
//   ['Rating:', 'None', 'Type:', 'None']
//   ['Operating Authority Status:', 'AUTHORIZED FOR Property...']
//   Inspections/crashes in table rows with numeric data
async function lookupFMCSA(mc_number: string): Promise<Record<string, unknown>> {
  const clean = mc_number.replace(/\D/g, "");
  const url = `https://safer.fmcsa.dot.gov/query.asp?searchtype=ANY&query_type=queryCarrierSnapshot&query_param=MC_MX&query_string=${clean}&action=get_data`;

  const response = await fetch(url, { signal: AbortSignal.timeout(10000) });
  if (!response.ok) throw new Error(`FMCSA API returned ${response.status}`);

  const html = await response.text();

  // Check for "no records found"
  if (html.includes("No records found") || html.includes("no records found")) {
    return {
      mc_number: clean,
      found: false,
      active: false,
      source: "FMCSA SAFER",
      checked_at: new Date().toISOString()
    };
  }

  // Parse all table rows into [label, value] pairs
  const rowData: Record<string, string> = {};
  const trPattern = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let trMatch: RegExpExecArray | null;

  while ((trMatch = trPattern.exec(html)) !== null) {
    const rowHtml = trMatch[1];
    // Extract all td/th cell text
    const cells: string[] = [];
    const tdPattern = /<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi;
    let tdMatch: RegExpExecArray | null;
    while ((tdMatch = tdPattern.exec(rowHtml)) !== null) {
      // Strip tags, decode entities, normalize whitespace
      const text = tdMatch[1]
        .replace(/<[^>]+>/g, " ")
        .replace(/&nbsp;/g, " ")
        .replace(/&#160;/g, " ")
        .replace(/&amp;/g, "&")
        .replace(/\s+/g, " ")
        .trim();
      if (text) cells.push(text);
    }

    // Map label: value pairs (cells come in pairs from FMCSA layout)
    for (let i = 0; i < cells.length - 1; i += 2) {
      const label = cells[i].replace(/:?\s*$/, "").trim();
      const value = cells[i + 1].trim();
      if (label && value) {
        rowData[label] = value;
      }
    }
    // Also capture single-cell rows that are values following a label row
    if (cells.length === 1 && cells[0].length > 3) {
      rowData[`_row_${Object.keys(rowData).length}`] = cells[0];
    }
  }

  // Extract specific fields
  const legalName     = rowData["Legal Name"] || rowData["Legal Name:"] || "";
  const dbaName       = rowData["DBA Name"] || rowData["DBA Name:"] || "";
  const usdotStatus   = rowData["USDOT Status"] || rowData["USDOT Status:"] || "";
  const usdotNumber   = rowData["USDOT Number"] || rowData["USDOT Number:"] || "";
  const outOfService  = rowData["Out of Service Date"] || rowData["Out of Service Date:"] || "None";
  const phone         = rowData["Phone"] || rowData["Phone:"] || "";
  const physAddress   = rowData["Physical Address"] || rowData["Physical Address:"] || "";
  const powerUnits    = rowData["Power Units"] || rowData["Power Units:"] || "";
  const mcs150Date    = rowData["MCS-150 Form Date"] || rowData["MCS-150 Form Date:"] || "";

  // Safety rating - in Review Information section
  const safetyRating  = rowData["Rating"] || rowData["Rating:"] || "None";

  // Operating authority - look for the status row
  const opAuthStatus  = rowData["Operating Authority Status"] || rowData["Operating Authority Status:"] || "";
  const isAuthorized  = opAuthStatus.includes("AUTHORIZED FOR") && !opAuthStatus.includes("NOT AUTHORIZED");
  const isActive      = usdotStatus.toUpperCase().includes("ACTIVE") && isAuthorized;

  // Years in operation from MCS-150 date
  let yearsInOperation: number | null = null;
  if (mcs150Date && mcs150Date !== "None") {
    const parts = mcs150Date.split("/");
    if (parts.length === 3) {
      const year = parseInt(parts[2]);
      if (!isNaN(year)) yearsInOperation = new Date().getFullYear() - year;
    }
  }

  return {
    mc_number: clean,
    found: true,
    entity_name: legalName.replace(/\s+/g, " ").trim(),
    dba_name: dbaName || null,
    operating_status: isAuthorized ? "AUTHORIZED" : "NOT AUTHORIZED",
    usdot_status: usdotStatus,
    usdot_number: usdotNumber,
    safety_rating: safetyRating === "None" ? "Not Rated" : safetyRating,
    out_of_service_date: outOfService === "None" ? null : outOfService,
    phone: phone || null,
    physical_address: physAddress || null,
    power_units: powerUnits || null,
    years_in_operation: yearsInOperation,
    active: isActive,
    authorized_for_hire: isAuthorized,
    source: "FMCSA SAFER",
    checked_at: new Date().toISOString()
  };
}

function runVerificationChecks(
  fmcsa: Record<string, unknown>,
  requirements: { min_insurance?: number; min_years?: number }
): Record<string, boolean | string> {
  const checks: Record<string, boolean | string> = {
    found_in_fmcsa: fmcsa.found === true,
    active_authority: fmcsa.active === true,
    authorized_for_hire: fmcsa.authorized_for_hire === true,
    no_unsatisfactory_rating: fmcsa.safety_rating !== "Unsatisfactory",
    not_out_of_service: !fmcsa.out_of_service_date,
  };

  if (requirements.min_years !== undefined && fmcsa.years_in_operation !== null) {
    checks.meets_min_years = (fmcsa.years_in_operation as number) >= requirements.min_years;
  }

  const allPassed = Object.values(checks).every(v => v === true);
  checks.overall_pass = allPassed;

  return checks;
}

// ── GEOCODING ───────────────────────────────────────────────────
async function geocodeAddress(address: string): Promise<{ lat: number; lng: number } | null> {
  if (!GOOGLE_GEOCODE_KEY) {
    const encoded = encodeURIComponent(address);
    const url = `https://nominatim.openstreetmap.org/search?q=${encoded}&format=json&limit=1&countrycodes=us`;
    const res = await fetch(url, {
      headers: { "User-Agent": "ConnectedCarriers/1.0 dispatch-verification" },
      signal: AbortSignal.timeout(6000)
    });
    if (!res.ok) return null;
    const data = await res.json() as Array<{ lat: string; lon: string }>;
    if (!data.length) return null;
    return { lat: parseFloat(data[0].lat), lng: parseFloat(data[0].lon) };
  }

  const encoded = encodeURIComponent(address);
  const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encoded}&key=${GOOGLE_GEOCODE_KEY}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(6000) });
  if (!res.ok) return null;
  const data = await res.json() as {
    status: string;
    results: Array<{ geometry: { location: { lat: number; lng: number } } }>;
  };
  if (data.status !== "OK" || !data.results.length) return null;
  return data.results[0].geometry.location;
}

// ── DISTANCE (Haversine) ─────────────────────────────────────────
function haversineDistance(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 3958.8;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat/2) ** 2 +
            Math.cos(lat1 * Math.PI/180) * Math.cos(lat2 * Math.PI/180) * Math.sin(dLng/2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function geofenceResult(miles: number): string {
  if (miles <= 1.0)  return "green";
  if (miles <= 2.0)  return "yellow";
  return "red";
}

// ── TWILIO SMS ───────────────────────────────────────────────────
async function sendSms(to: string, body: string): Promise<boolean> {
  if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || !TWILIO_PHONE_NUMBER) {
    console.error(`[SMS SKIPPED — no Twilio config] To: ${to} | ${body}`);
    return false;
  }
  const url = `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Messages.json`;
  const creds = Buffer.from(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`).toString("base64");
  const params = new URLSearchParams({ To: to, From: TWILIO_PHONE_NUMBER, Body: body });
  const res = await fetch(url, {
    method: "POST",
    headers: { "Authorization": `Basic ${creds}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
    signal: AbortSignal.timeout(8000)
  });
  if (!res.ok) {
    const err = await res.text();
    console.error(`[SMS ERROR] ${res.status}: ${err}`);
    return false;
  }
  return true;
}

// ── HTTP SERVER ──────────────────────────────────────────────────
const PORT = parseInt(process.env.PORT || "3000");

const httpServer = http.createServer(async (req, res) => {
  const url = req.url || "";

  // ── MCP endpoint — fresh McpServer + transport per request (SDK 1.29.0 requirement)
  if (req.method === "POST" && url === "/mcp") {
    const mcpServer = buildMcpServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    try {
      await mcpServer.connect(transport);
      const bodyBuf = await readBody(req);
      const bodyJson = bodyBuf.length ? JSON.parse(bodyBuf.toString()) : undefined;
      await transport.handleRequest(req, res, bodyJson);
      res.on("close", () => { transport.close(); mcpServer.close(); });
    } catch (err) {
      console.error("[MCP handler error]", err);
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: null }));
      }
    }
    return;
  }

  // ── Health check
  if (url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok", service: "cc-mcp-server", version: "1.2.0" }));
    return;
  }

  // ── POST /dispatch
  if (req.method === "POST" && url === "/dispatch") {
    setCors(res);
    try {
      const body = JSON.parse((await readBody(req)).toString());
      const { driver_phone, broker_phone, mc_number, pickup_address, pickup_window_start, pickup_window_end, replaces_load_id } = body;

      if (!driver_phone || !broker_phone || !pickup_address) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "driver_phone, broker_phone, and pickup_address are required" }));
        return;
      }

      // ── SUPERSEDE: if this replaces an existing load, mark the old one ──
      let superseded_load: string | null = null;
      let superseded_driver_phone: string | null = null;

      if (replaces_load_id) {
        // Explicit reassignment — broker told us which load this replaces
        const old = await query(
          "SELECT * FROM dispatch_verifications WHERE load_id = $1 AND status = 'pending'",
          [replaces_load_id]
        );
        if (old.rows.length) {
          superseded_load = old.rows[0].load_id;
          superseded_driver_phone = old.rows[0].driver_phone;
          await query(
            "UPDATE dispatch_verifications SET status = 'superseded' WHERE load_id = $1",
            [replaces_load_id]
          );
        }
      } else {
        // Auto-detect: if same broker + same pickup address has a pending verification, supersede it
        const existing = await query(
          `SELECT * FROM dispatch_verifications
           WHERE broker_phone = $1 AND pickup_address = $2 AND status = 'pending'
           ORDER BY created_at DESC LIMIT 1`,
          [normalizePhone(broker_phone), pickup_address]
        );
        if (existing.rows.length) {
          superseded_load = existing.rows[0].load_id;
          superseded_driver_phone = existing.rows[0].driver_phone;
          await query(
            "UPDATE dispatch_verifications SET status = 'superseded' WHERE id = $1",
            [existing.rows[0].id]
          );
        }
      }

      // Notify the superseded driver — let them know, and nudge them to complete their profile
      if (superseded_driver_phone && superseded_driver_phone !== normalizePhone(driver_phone)) {
        const profileUrl = `${BASE_URL}/carrier-profile`;
        await sendSms(
          superseded_driver_phone,
          `Load ${superseded_load} has been assigned to another carrier. No action needed on this load.\nWant to get cleared faster next time? Complete your carrier profile: ${profileUrl}`
        );
        console.error(`[SUPERSEDE] ${superseded_load} superseded — old driver ${superseded_driver_phone} notified`);
      }

      const load_id = `CC-${new Date().toISOString().slice(0,10).replace(/-/g,"")}-${crypto.randomBytes(3).toString("hex").toUpperCase()}`;
      const token   = crypto.randomBytes(32).toString("hex");

      const coords = await geocodeAddress(pickup_address);

      let fmcsa_authority: string | null = null;
      let fmcsa_company: string | null = null;
      if (mc_number) {
        try {
          const fmcsa = await lookupFMCSA(mc_number);
          fmcsa_authority = fmcsa.active ? "Active" : "Inactive/Unknown";
          fmcsa_company   = fmcsa.entity_name as string || null;
        } catch { /* non-blocking */ }
      }

      await query(
        `INSERT INTO dispatch_verifications
         (load_id, token, driver_phone, broker_phone, mc_number,
          pickup_address, pickup_window_start, pickup_window_end,
          geo_center_lat, geo_center_lng, fmcsa_authority, fmcsa_company)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [
          load_id, token,
          normalizePhone(driver_phone), normalizePhone(broker_phone),
          mc_number || null, pickup_address,
          pickup_window_start || null, pickup_window_end || null,
          coords?.lat || null, coords?.lng || null,
          fmcsa_authority, fmcsa_company
        ]
      );

      const verifyUrl  = `${BASE_URL}/verify/${token}`;
      const driverSms  = `${load_id} — pickup at ${pickup_address.split(",")[0]}.\nConfirm arrival when you get there: ${verifyUrl}\nThis request is time-sensitive.`;
      const smsSent    = await sendSms(normalizePhone(driver_phone), driverSms);

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        success: true,
        load_id,
        superseded: superseded_load,
        geocoded: Boolean(coords),
        fmcsa_authority,
        fmcsa_company,
        sms_sent: smsSent,
        verify_url: verifyUrl
      }));

    } catch (err) {
      console.error("[POST /dispatch error]", err);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Internal server error" }));
    }
    return;
  }

  // ── GET /carrier-profile — redirect to carrier profile form
  if (req.method === "GET" && url === "/carrier-profile") {
    res.writeHead(302, { "Location": "https://app.connectedcarriers.org/profile/carrier?source=superseded_nudge" });
    res.end();
    return;
  }

  // ── POST /load/create — broker creates a load with a shareable apply link
  if (req.method === "POST" && url === "/load/create") {
    setCors(res);
    try {
      const body = JSON.parse((await readBody(req)).toString());
      const { origin, destination, equipment, pickup_date, rate_note, notes, broker_phone, broker_email } = body;

      if (!origin || !destination || !equipment) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "origin, destination, and equipment are required" }));
        return;
      }

      const load_id = `HX-${new Date().toISOString().slice(0,10).replace(/-/g,"").slice(4)}-${crypto.randomBytes(2).toString("hex").toUpperCase()}`;
      const slug = crypto.randomBytes(4).toString("hex").toUpperCase();

      await query(
        `INSERT INTO loads (load_id, slug, broker_phone, broker_email, origin, destination, equipment, pickup_date, rate_note, notes)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [load_id, slug, normalizePhone(broker_phone || ""), broker_email || null,
         origin, destination, equipment, pickup_date || null, rate_note || null, notes || null]
      );

      const applyUrl = `${BASE_URL}/load/${slug}`;
      const postText = `${equipment} — ${origin} → ${destination}${pickup_date ? `\nPickup: ${pickup_date}` : ""}\n\nSubmit MC to get qualified:\n${applyUrl}`;

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        success: true,
        load_id,
        slug,
        apply_url: applyUrl,
        post_text: postText
      }));
    } catch (err) {
      console.error("[POST /load/create error]", err);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Internal server error" }));
    }
    return;
  }

  // ── GET /load/:slug — public load apply page (one field, one button)
  if (req.method === "GET" && url.match(/^\/load\/[A-Z0-9]+$/)) {
    const slug = url.replace("/load/", "");
    try {
      const result = await query("SELECT * FROM loads WHERE slug = $1", [slug]);
      if (!result.rows.length) {
        res.writeHead(404, { "Content-Type": "text/html" });
        res.end(loadNotFoundPage());
        return;
      }
      const load = result.rows[0];
      if (load.status !== "open") {
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(loadClosedPage(load));
        return;
      }
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(loadApplyPage(load, slug));
    } catch (err) {
      console.error("[GET /load error]", err);
      res.writeHead(500); res.end("Server error");
    }
    return;
  }

  // ── POST /load/:slug/check — MC qualification check (instant)
  if (req.method === "POST" && url.match(/^\/load\/[A-Z0-9]+\/check$/)) {
    setCors(res);
    const slug = url.split("/")[2];
    try {
      const body = JSON.parse((await readBody(req)).toString());
      const { mc_number } = body;

      if (!mc_number) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "MC number is required" }));
        return;
      }

      const loadResult = await query("SELECT * FROM loads WHERE slug = $1 AND status = 'open'", [slug]);
      if (!loadResult.rows.length) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Load not found or closed" }));
        return;
      }
      const load = loadResult.rows[0];

      // Rate limit: max 10 checks per MC per hour
      const recentChecks = await query(
        "SELECT COUNT(*) as count FROM load_applications WHERE mc_number = $1 AND created_at > NOW() - INTERVAL '1 hour'",
        [mc_number.replace(/\D/g, "")]
      );
      if (parseInt(recentChecks.rows[0].count) >= 10) {
        res.writeHead(429, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Too many checks. Please try again later." }));
        return;
      }

      // FMCSA lookup
      let fmcsa_authority = "unknown";
      let fmcsa_safety = "unknown";
      let fmcsa_company = "unknown";
      let qualification = "not_qualified";
      let details: Record<string, unknown> = {};

      try {
        const fmcsa = await lookupFMCSA(mc_number);
        fmcsa_authority = fmcsa.active ? "Active" : "Inactive";
        fmcsa_safety = (fmcsa.safety_rating as string) || "None";
        fmcsa_company = (fmcsa.entity_name as string) || "Unknown";
        details = fmcsa;

        if (!fmcsa.active) {
          qualification = "not_qualified";
        } else if (fmcsa_safety === "Unsatisfactory") {
          qualification = "not_qualified";
        } else if (fmcsa_safety === "Conditional") {
          qualification = "review";
        } else {
          qualification = "qualified";
        }
      } catch {
        qualification = "review";
        details = { error: "FMCSA lookup failed — manual review needed" };
      }

      // Check if carrier has a completed profile
      let hasProfile = false;
      try {
        // Check MCP server's own carriers table
        const profileCheck = await query(
          "SELECT id FROM carriers WHERE mc_number = $1", [mc_number.replace(/\D/g, "")]
        );
        hasProfile = profileCheck.rows.length > 0;
      } catch { /* ignore */ }

      // Save the application
      await query(
        `INSERT INTO load_applications
         (load_id, mc_number, company_name, fmcsa_authority, fmcsa_safety, fmcsa_company,
          qualification_result, qualification_details, has_profile)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [load.id, mc_number.replace(/\D/g, ""), fmcsa_company, fmcsa_authority, fmcsa_safety, fmcsa_company,
         qualification, JSON.stringify(details), hasProfile]
      );

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        qualification,
        company_name: fmcsa_company,
        authority: fmcsa_authority,
        safety: fmcsa_safety,
        has_profile: hasProfile,
        profile_url: `${BASE_URL.replace("cc-mcp-server-production.up.railway.app", "app.connectedcarriers.org")}/profile/carrier`
      }));

    } catch (err) {
      console.error("[POST /load/check error]", err);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Server error" }));
    }
    return;
  }

  // ── POST /load/:slug/interest — carrier submits contact info after qualification
  if (req.method === "POST" && url.match(/^\/load\/[A-Z0-9]+\/interest$/)) {
    setCors(res);
    const slug = url.split("/")[2];
    try {
      const body = JSON.parse((await readBody(req)).toString());
      const { mc_number, contact_name, contact_phone, contact_email } = body;

      // Update the most recent application for this MC on this load
      const loadResult = await query("SELECT id FROM loads WHERE slug = $1", [slug]);
      if (!loadResult.rows.length) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Load not found" }));
        return;
      }

      await query(
        `UPDATE load_applications SET contact_name = $1, contact_phone = $2, contact_email = $3
         WHERE load_id = $4 AND mc_number = $5
         AND id = (SELECT MAX(id) FROM load_applications WHERE load_id = $4 AND mc_number = $5)`,
        [contact_name || null, contact_phone || null, contact_email || null,
         loadResult.rows[0].id, mc_number.replace(/\D/g, "")]
      );

      // Notify broker via SMS if phone is set
      const load = (await query("SELECT * FROM loads WHERE slug = $1", [slug])).rows[0];
      if (load?.broker_phone) {
        await sendSms(load.broker_phone,
          `New qualified carrier for ${load.load_id}:\n${body.contact_name || "Unknown"} — MC ${mc_number}\n${contact_phone || ""}\nCheck your load board.`
        );
      }

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: true }));
    } catch (err) {
      console.error("[POST /load/interest error]", err);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Server error" }));
    }
    return;
  }

  // ── GET /loads/:load_id/applicants — broker views qualified carriers for a load
  if (req.method === "GET" && url.match(/^\/loads\/[A-Z0-9-]+\/applicants$/)) {
    setCors(res);
    const load_id = url.split("/")[2];
    try {
      const load = (await query("SELECT * FROM loads WHERE load_id = $1", [load_id])).rows[0];
      if (!load) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Load not found" }));
        return;
      }
      const apps = await query(
        `SELECT mc_number, company_name, contact_name, contact_phone, contact_email,
                fmcsa_authority, fmcsa_safety, qualification_result, has_profile, created_at
         FROM load_applications WHERE load_id = $1 ORDER BY created_at DESC`,
        [load.id]
      );
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ load_id, origin: load.origin, destination: load.destination, applicants: apps.rows }));
    } catch (err) {
      console.error("[GET /loads/applicants error]", err);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Server error" }));
    }
    return;
  }

  // ── GET /verify/:token
  if (req.method === "GET" && url.startsWith("/verify/")) {
    const token = url.replace("/verify/", "").split("?")[0];
    try {
      const result = await query("SELECT * FROM dispatch_verifications WHERE token = $1", [token]);
      if (!result.rows.length) {
        res.writeHead(404, { "Content-Type": "text/html" });
        res.end(verifyNotFoundPage());
        return;
      }
      const v = result.rows[0];
      if (v.status === "confirmed") {
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(verifyAlreadyConfirmedPage(v));
        return;
      }
      if (v.status === "superseded") {
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(verifySupersededPage(v));
        return;
      }
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(verifyPage(v, token));
    } catch (err) {
      console.error("[GET /verify error]", err);
      res.writeHead(500); res.end("Server error");
    }
    return;
  }

  // ── POST /verify/:token
  if (req.method === "POST" && url.startsWith("/verify/")) {
    setCors(res);
    const token = url.replace("/verify/", "").split("?")[0];
    try {
      const body = JSON.parse((await readBody(req)).toString());
      const { lat, lng } = body;

      const result = await query("SELECT * FROM dispatch_verifications WHERE token = $1", [token]);
      if (!result.rows.length) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Not found" }));
        return;
      }

      const v = result.rows[0];
      if (v.status === "confirmed") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ already_confirmed: true }));
        return;
      }

      if (v.status === "superseded") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          confirmed: false,
          superseded: true,
          message: "This load has been reassigned to another carrier. No action needed."
        }));
        return;
      }

      let distance_miles: number | null = null;
      let fence_result = "unknown";
      if (lat && lng && v.geo_center_lat && v.geo_center_lng) {
        distance_miles = haversineDistance(v.geo_center_lat, v.geo_center_lng, lat, lng);
        fence_result   = geofenceResult(distance_miles);
      }

      // ── REQUIRE LOCATION: if driver denied GPS, bounce them ──
      if (!lat || !lng) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          confirmed: false,
          no_location: true,
          message: "We need your location to confirm you're at the pickup. Please allow location access and try again."
        }));
        return;
      }

      // ── GEOFENCE BOUNCE: if driver is outside the geofence, don't confirm ──
      // Token stays active so they can try again when closer
      if (fence_result === "red" && distance_miles !== null) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          confirmed: false,
          too_far: true,
          distance_miles: Math.round(distance_miles * 100) / 100,
          message: "You're not at the pickup yet. Tap this link again when you arrive."
        }));
        return;
      }

      // ── EARLY ARRIVAL CHECK ──
      let timing_flag = "on_time";
      if (v.pickup_window_start) {
        const now = new Date();
        // Parse pickup window start — expected format like "1:00 PM"
        const windowStr = String(v.pickup_window_start).trim();
        const today = now.toISOString().split("T")[0];
        const windowDate = new Date(`${today} ${windowStr}`);
        if (!isNaN(windowDate.getTime())) {
          const msBefore = windowDate.getTime() - now.getTime();
          const hoursBefore = msBefore / (1000 * 60 * 60);
          if (hoursBefore > 2) timing_flag = "very_early";
          else if (hoursBefore > 0.5) timing_flag = "early";
        }
      }

      const confirmed_at = new Date();

      await query(
        `UPDATE dispatch_verifications
         SET status = 'confirmed', confirmed_at = $1,
             confirmed_lat = $2, confirmed_lng = $3,
             distance_miles = $4, geofence_result = $5
         WHERE token = $6`,
        [confirmed_at, lat || null, lng || null, distance_miles, fence_result, token]
      );

      const brokerSms = buildBrokerSms(v.load_id, distance_miles, fence_result, confirmed_at, timing_flag);
      const notified  = await sendSms(v.broker_phone, brokerSms);

      if (notified) {
        await query("UPDATE dispatch_verifications SET broker_notified_at = NOW() WHERE token = $1", [token]);
      }

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        confirmed: true,
        load_id: v.load_id,
        distance_miles: distance_miles ? Math.round(distance_miles * 100) / 100 : null,
        geofence_result: fence_result,
        timing_flag,
        broker_notified: notified
      }));

    } catch (err) {
      console.error("[POST /verify error]", err);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Server error" }));
    }
    return;
  }

  // ── GET /status/:load_id
  if (req.method === "GET" && url.startsWith("/status/")) {
    const load_id = url.replace("/status/", "").split("?")[0];
    try {
      const result = await query(
        `SELECT load_id, status, pickup_address, pickup_window_start, pickup_window_end,
                mc_number, fmcsa_authority, fmcsa_company,
                sent_at, confirmed_at, distance_miles, geofence_result, broker_notified_at
         FROM dispatch_verifications WHERE load_id = $1`,
        [load_id]
      );
      if (!result.rows.length) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Load not found" }));
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(result.rows[0]));
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Server error" }));
    }
    return;
  }

  // OPTIONS preflight
  if (req.method === "OPTIONS") {
    setCors(res);
    res.writeHead(204); res.end();
    return;
  }

  res.writeHead(404); res.end("Not found");
});

// ── HELPERS ──────────────────────────────────────────────────────
function setCors(res: http.ServerResponse) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function normalizePhone(phone: string): string {
  const digits = phone.replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return `+${digits}`;
}

function buildBrokerSms(
  load_id: string,
  distance: number | null,
  fence: string,
  confirmed_at: Date,
  timing: string = "on_time"
): string {
  const time = confirmed_at.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true });
  const dist = distance !== null ? `${Math.round(distance * 100) / 100} mi` : "location unavailable";
  const earlyWarning = timing === "very_early" ? "\n⚠ EARLY — confirmed well before pickup window" :
                       timing === "early" ? "\nNote: confirmed before pickup window" : "";

  if (fence === "green") return `CC ${load_id} confirmed ✓\n${dist} from pickup — ${time}${earlyWarning}\nStatus: ON SITE`;
  if (fence === "yellow") return `CC ${load_id} — nearby\n${dist} from pickup — ${time}${earlyWarning}\nStatus: NEAR — confirm before loading`;
  return `CC ${load_id} confirmed — ${time}\nLocation check unavailable`;
}

async function readBody(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", chunk => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

// ── DRIVER VERIFY PAGE ────────────────────────────────────────────
function verifyPage(v: Record<string, unknown>, token: string): string {
  const addr = String(v.pickup_address || "").split(",")[0];
  const window_str = v.pickup_window_start
    ? `${v.pickup_window_start}${v.pickup_window_end ? ` – ${v.pickup_window_end}` : ""}`
    : "";
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0">
<title>Confirm Arrival — ${v.load_id}</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #1C2B3A; min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 20px; }
  .card { background: #fff; border-radius: 12px; padding: 28px 24px; max-width: 360px; width: 100%; }
  .tag { font-size: 11px; font-weight: 600; letter-spacing: 0.1em; text-transform: uppercase; color: #C8892A; margin-bottom: 16px; }
  .load { font-size: 22px; font-weight: 600; color: #1C2B3A; margin-bottom: 20px; }
  .row { margin-bottom: 14px; }
  .row label { font-size: 11px; font-weight: 600; letter-spacing: 0.06em; text-transform: uppercase; color: #8a9aaa; display: block; margin-bottom: 3px; }
  .row p { font-size: 15px; color: #1C2B3A; }
  .divider { height: 1px; background: #e8e4de; margin: 20px 0; }
  .btn { width: 100%; padding: 14px; background: #C8892A; border: none; border-radius: 6px; color: #1C2B3A; font-size: 16px; font-weight: 600; cursor: pointer; }
  .btn:active { opacity: 0.85; }
  .geo-note { font-size: 12px; color: #8a9aaa; text-align: center; margin-top: 10px; }
  .success { display: none; text-align: center; }
  .success .check { font-size: 48px; margin-bottom: 12px; }
  .success h2 { font-size: 20px; color: #1C2B3A; margin-bottom: 8px; }
  .success p { font-size: 14px; color: #6b7a8a; }
  .error-msg { color: #a32d2d; font-size: 13px; text-align: center; margin-top: 10px; display: none; }
  .too-far { display: none; text-align: center; margin-top: 14px; padding: 14px; background: #FFF8ED; border: 1px solid #F0DFC0; border-radius: 6px; }
  .too-far p { font-size: 14px; color: #8B6914; margin-bottom: 4px; }
  .too-far .dist { font-size: 12px; color: #a08040; }
</style>
</head>
<body>
<div class="card">
  <div id="confirm-view">
    <div class="tag">Arrival Verification</div>
    <div class="load">${v.load_id}</div>
    <div class="row">
      <label>Pickup location</label>
      <p>${addr}</p>
    </div>
    ${window_str ? `<div class="row"><label>Pickup window</label><p>${window_str}</p></div>` : ""}
    <div class="divider"></div>
    <button class="btn" id="confirm-btn" onclick="confirmArrival()">Confirm arrival</button>
    <p class="geo-note">Location is required to confirm you're at the pickup.</p>
    <p class="error-msg" id="err-msg"></p>
    <div class="too-far" id="too-far-msg">
      <p>You're not at the pickup yet.</p>
      <p class="dist" id="too-far-dist"></p>
      <p class="dist">Tap "Confirm arrival" again when you get there.</p>
    </div>
  </div>
  <div class="success" id="success-view">
    <div class="check">✓</div>
    <h2>Arrival confirmed</h2>
    <p>Your broker has been notified.</p>
  </div>
</div>
<script>
function confirmArrival() {
  const btn = document.getElementById('confirm-btn');
  btn.textContent = 'Getting location...';
  btn.disabled = true;
  document.getElementById('too-far-msg').style.display = 'none';
  document.getElementById('err-msg').style.display = 'none';
  if (!navigator.geolocation) {
    showErr('Location is required to confirm arrival. Please enable location services and try again.');
    btn.disabled = false;
    btn.textContent = 'Confirm arrival';
    return;
  }
  navigator.geolocation.getCurrentPosition(
    pos => postConfirm(pos.coords.latitude, pos.coords.longitude),
    ()  => {
      showErr('Location access was denied. Please allow location and try again.');
      btn.disabled = false;
      btn.textContent = 'Confirm arrival';
    },
    { timeout: 8000, maximumAge: 0 }
  );
}
async function postConfirm(lat, lng) {
  try {
    const res = await fetch('/verify/${token}', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ lat, lng })
    });
    const data = await res.json();
    if (data.confirmed || data.already_confirmed) {
      document.getElementById('confirm-view').style.display = 'none';
      document.getElementById('success-view').style.display = 'block';
    } else if (data.too_far) {
      document.getElementById('too-far-msg').style.display = 'block';
      document.getElementById('too-far-dist').textContent = 'About ' + data.distance_miles + ' miles away.';
      document.getElementById('confirm-btn').disabled = false;
      document.getElementById('confirm-btn').textContent = 'Confirm arrival';
    } else if (data.no_location) {
      showErr(data.message);
      document.getElementById('confirm-btn').disabled = false;
      document.getElementById('confirm-btn').textContent = 'Confirm arrival';
    } else if (data.superseded) {
      document.getElementById('confirm-view').style.display = 'none';
      document.getElementById('success-view').innerHTML = '<div style="font-size:48px;margin-bottom:12px">↩</div><h2>Load reassigned</h2><p>This load has been assigned to another carrier. No action needed.</p>';
      document.getElementById('success-view').style.display = 'block';
    } else { showErr('Something went wrong. Please try again.'); }
  } catch(e) {
    showErr('Network error. Please try again.');
    document.getElementById('confirm-btn').disabled = false;
    document.getElementById('confirm-btn').textContent = 'Confirm arrival';
  }
}
function showErr(msg) {
  const el = document.getElementById('err-msg');
  el.textContent = msg;
  el.style.display = 'block';
}
</script>
</body>
</html>`;
}

function verifyNotFoundPage(): string {
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Not Found</title>
  <style>body{font-family:-apple-system,sans-serif;background:#1C2B3A;display:flex;align-items:center;justify-content:center;min-height:100vh;padding:20px}
  .card{background:#fff;border-radius:12px;padding:28px 24px;max-width:360px;width:100%;text-align:center}
  h2{color:#1C2B3A;margin-bottom:8px}p{color:#6b7a8a;font-size:14px}</style></head>
  <body><div class="card"><h2>Link not found</h2><p>This verification link is invalid or has expired. Contact your broker for a new link.</p></div></body></html>`;
}

function verifyAlreadyConfirmedPage(v: Record<string, unknown>): string {
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Already Confirmed</title>
  <style>body{font-family:-apple-system,sans-serif;background:#1C2B3A;display:flex;align-items:center;justify-content:center;min-height:100vh;padding:20px}
  .card{background:#fff;border-radius:12px;padding:28px 24px;max-width:360px;width:100%;text-align:center}
  .check{font-size:48px;margin-bottom:12px}h2{color:#1C2B3A;margin-bottom:8px}p{color:#6b7a8a;font-size:14px}</style></head>
  <body><div class="card"><div class="check">✓</div><h2>Already confirmed</h2><p>Load ${v.load_id} was already confirmed. Your broker has been notified.</p></div></body></html>`;
}

function verifySupersededPage(v: Record<string, unknown>): string {
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Load Reassigned</title>
  <style>body{font-family:-apple-system,sans-serif;background:#1C2B3A;display:flex;align-items:center;justify-content:center;min-height:100vh;padding:20px}
  .card{background:#fff;border-radius:12px;padding:28px 24px;max-width:360px;width:100%;text-align:center}
  .icon{font-size:48px;margin-bottom:12px}h2{color:#1C2B3A;margin-bottom:8px}p{color:#6b7a8a;font-size:14px;margin-bottom:8px}
  .btn{display:inline-block;margin-top:16px;padding:12px 24px;background:#C8892A;color:#1C2B3A;border-radius:6px;text-decoration:none;font-weight:600;font-size:14px}</style></head>
  <body><div class="card"><div class="icon">↩</div><h2>Load reassigned</h2><p>Load ${v.load_id} has been assigned to another carrier. No action needed on this load.</p><p>Want to get cleared faster next time?</p><a href="${BASE_URL}/carrier-profile" class="btn">Complete your carrier profile</a></div></body></html>`;
}

// ── LOAD APPLY PAGES ─────────────────────────────────────────────

function loadApplyPage(load: Record<string, unknown>, slug: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0">
<title>${load.equipment} — ${load.origin} → ${load.destination}</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #1C2B3A; min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 20px; }
  .card { background: #fff; border-radius: 12px; padding: 28px 24px; max-width: 400px; width: 100%; }
  .tag { font-size: 11px; font-weight: 600; letter-spacing: 0.1em; text-transform: uppercase; color: #C8892A; margin-bottom: 12px; }
  .route { font-size: 20px; font-weight: 600; color: #1C2B3A; margin-bottom: 6px; }
  .detail { font-size: 13px; color: #6b7a8a; margin-bottom: 4px; }
  .divider { height: 1px; background: #e8e4de; margin: 18px 0; }
  .label { font-size: 11px; font-weight: 600; letter-spacing: 0.06em; text-transform: uppercase; color: #6b7a8a; margin-bottom: 6px; }
  .mc-input { width: 100%; padding: 14px 16px; border: 2px solid #e8e4de; border-radius: 8px; font-size: 18px; font-weight: 600; color: #1C2B3A; text-align: center; letter-spacing: 0.05em; outline: none; }
  .mc-input:focus { border-color: #C8892A; }
  .mc-input::placeholder { color: #c0c0c0; font-weight: 400; }
  .btn { width: 100%; padding: 14px; background: #C8892A; border: none; border-radius: 8px; color: #1C2B3A; font-size: 16px; font-weight: 600; cursor: pointer; margin-top: 12px; }
  .btn:active { opacity: 0.85; }
  .btn:disabled { opacity: 0.5; cursor: not-allowed; }
  .result { display: none; margin-top: 16px; padding: 16px; border-radius: 8px; text-align: center; }
  .result.qualified { background: #EAF3DE; border: 1px solid #c5e0a0; }
  .result.review { background: #FFF8ED; border: 1px solid #F0DFC0; }
  .result.not_qualified { background: #FCEBEB; border: 1px solid #f0c0c0; }
  .result h3 { font-size: 16px; margin-bottom: 6px; }
  .result p { font-size: 13px; color: #6b7a8a; }
  .result.qualified h3 { color: #3b6d11; }
  .result.review h3 { color: #8B6914; }
  .result.not_qualified h3 { color: #a32d2d; }
  .interest-form { display: none; margin-top: 16px; }
  .interest-form input { width: 100%; padding: 10px 12px; border: 1px solid #e8e4de; border-radius: 6px; font-size: 14px; margin-bottom: 8px; outline: none; }
  .interest-form input:focus { border-color: #C8892A; }
  .interest-btn { width: 100%; padding: 12px; background: #1C2B3A; border: none; border-radius: 6px; color: #F7F5F0; font-size: 14px; font-weight: 600; cursor: pointer; }
  .profile-link { display: block; margin-top: 12px; text-align: center; font-size: 12px; color: #C8892A; text-decoration: none; }
  .submitted-msg { display: none; text-align: center; margin-top: 16px; }
  .submitted-msg .check { font-size: 36px; margin-bottom: 8px; }
  .submitted-msg p { font-size: 14px; color: #6b7a8a; }
  .powered { text-align: center; font-size: 11px; color: #6b7a8a; margin-top: 20px; }
  .powered a { color: #C8892A; text-decoration: none; }
</style>
</head>
<body>
<div class="card">
  <div class="tag">Load Available</div>
  <div class="route">${load.origin} → ${load.destination}</div>
  <div class="detail">${load.equipment}${load.pickup_date ? ` · Pickup: ${load.pickup_date}` : ""}</div>
  ${load.rate_note ? `<div class="detail">${load.rate_note}</div>` : ""}

  <div class="divider"></div>

  <div id="check-view">
    <div class="label">Enter your MC number</div>
    <input type="text" class="mc-input" id="mc-input" placeholder="1234567" inputmode="numeric" maxlength="10" autocomplete="off">
    <button class="btn" id="check-btn" onclick="checkMC()">Check Qualification</button>
  </div>

  <div class="result" id="result-box">
    <h3 id="result-title"></h3>
    <p id="result-detail"></p>
  </div>

  <div class="interest-form" id="interest-form">
    <div class="label" style="margin-bottom:8px">Submit your interest</div>
    <input type="text" id="int-name" placeholder="Your name">
    <input type="tel" id="int-phone" placeholder="Phone number" inputmode="tel">
    <input type="email" id="int-email" placeholder="Email (optional)">
    <button class="interest-btn" id="interest-btn" onclick="submitInterest()">I'm Interested in This Load</button>
    <a href="https://app.connectedcarriers.org/profile/carrier" class="profile-link">Complete your carrier profile for faster qualification →</a>
  </div>

  <div class="submitted-msg" id="submitted-msg">
    <div class="check">✓</div>
    <p>Your interest has been submitted. The broker will be in touch if they'd like to move forward.</p>
    <a href="https://app.connectedcarriers.org/profile/carrier" class="profile-link" style="margin-top:16px">Complete your carrier profile to get cleared faster next time →</a>
  </div>

  <div class="powered">Powered by <a href="https://connectedcarriers.org">Connected Carriers</a></div>
</div>

<script>
let mcChecked = '';

function checkMC() {
  const mc = document.getElementById('mc-input').value.replace(/\\D/g, '').trim();
  if (!mc) return;
  mcChecked = mc;
  const btn = document.getElementById('check-btn');
  btn.disabled = true; btn.textContent = 'Checking...';
  document.getElementById('result-box').style.display = 'none';
  document.getElementById('interest-form').style.display = 'none';

  fetch('/load/${slug}/check', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mc_number: mc })
  })
  .then(r => r.json())
  .then(data => {
    const box = document.getElementById('result-box');
    const title = document.getElementById('result-title');
    const detail = document.getElementById('result-detail');
    box.className = 'result ' + data.qualification;

    if (data.qualification === 'qualified') {
      title.textContent = '✓ Qualified — ' + (data.company_name || 'MC ' + mc);
      detail.textContent = 'Authority: ' + data.authority + ' · Safety: ' + data.safety;
      document.getElementById('interest-form').style.display = 'block';
    } else if (data.qualification === 'review') {
      title.textContent = '⚠ Needs Review — ' + (data.company_name || 'MC ' + mc);
      detail.textContent = 'Authority: ' + data.authority + ' · Safety: ' + data.safety + '. The broker may follow up.';
      document.getElementById('interest-form').style.display = 'block';
    } else {
      title.textContent = '✗ Does Not Qualify';
      detail.textContent = data.authority === 'Inactive' ? 'FMCSA authority is not active for this MC number.' : 'This carrier does not meet the requirements for this load.';
    }
    box.style.display = 'block';
    btn.disabled = false; btn.textContent = 'Check Another MC';
  })
  .catch(() => {
    btn.disabled = false; btn.textContent = 'Check Qualification';
    alert('Something went wrong. Please try again.');
  });
}

function submitInterest() {
  const btn = document.getElementById('interest-btn');
  btn.disabled = true; btn.textContent = 'Submitting...';
  fetch('/load/${slug}/interest', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      mc_number: mcChecked,
      contact_name: document.getElementById('int-name').value,
      contact_phone: document.getElementById('int-phone').value,
      contact_email: document.getElementById('int-email').value
    })
  })
  .then(r => r.json())
  .then(() => {
    document.getElementById('interest-form').style.display = 'none';
    document.getElementById('submitted-msg').style.display = 'block';
  })
  .catch(() => {
    btn.disabled = false; btn.textContent = "I'm Interested in This Load";
    alert('Something went wrong. Please try again.');
  });
}

document.getElementById('mc-input').addEventListener('keydown', function(e) {
  if (e.key === 'Enter') checkMC();
});
</script>
</body>
</html>`;
}

function loadNotFoundPage(): string {
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Load Not Found</title>
  <style>body{font-family:-apple-system,sans-serif;background:#1C2B3A;display:flex;align-items:center;justify-content:center;min-height:100vh;padding:20px}
  .card{background:#fff;border-radius:12px;padding:28px 24px;max-width:360px;width:100%;text-align:center}
  h2{color:#1C2B3A;margin-bottom:8px}p{color:#6b7a8a;font-size:14px}</style></head>
  <body><div class="card"><h2>Load not found</h2><p>This load link is invalid or has expired. Contact the broker for an updated link.</p></div></body></html>`;
}

function loadClosedPage(load: Record<string, unknown>): string {
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Load Covered</title>
  <style>body{font-family:-apple-system,sans-serif;background:#1C2B3A;display:flex;align-items:center;justify-content:center;min-height:100vh;padding:20px}
  .card{background:#fff;border-radius:12px;padding:28px 24px;max-width:360px;width:100%;text-align:center}
  h2{color:#1C2B3A;margin-bottom:8px}p{color:#6b7a8a;font-size:14px}
  .btn{display:inline-block;margin-top:16px;padding:12px 24px;background:#C8892A;color:#1C2B3A;border-radius:6px;text-decoration:none;font-weight:600;font-size:14px}</style></head>
  <body><div class="card"><h2>Load covered</h2><p>${load.origin} → ${load.destination} has been assigned to a carrier.</p><a href="https://app.connectedcarriers.org/profile/carrier" class="btn">Complete your carrier profile</a></div></body></html>`;
}

// ── STARTUP ───────────────────────────────────────────────────────
initDb().then(async () => {
  httpServer.listen(PORT, () => {
    console.error(`cc-mcp-server v1.2.0 running on port ${PORT}`);
    console.error(`MCP tools: cc_lookup_carrier, cc_verify_carrier, cc_assign_tier`);
    console.error(`Routes: POST /dispatch | GET+POST /verify/:token | GET /status/:load_id`);
    console.error(`Twilio: ${TWILIO_ACCOUNT_SID ? "configured" : "NOT configured — SMS disabled"}`);
    console.error(`Geocoding: ${GOOGLE_GEOCODE_KEY ? "Google Maps" : "Nominatim (fallback)"}`);
  });

  // ── REMINDER / NUDGE TIMER ─────────────────────────────────────
  // Runs every 2 minutes. Two jobs:
  // 1. Driver nudge: if pending + no confirmation after 10 min, send reminder (max 2)
  // 2. Broker "no confirmation" alert: if pending + pickup window approaching, alert broker
  setInterval(async () => {
    try {
      const now = new Date();

      // ── JOB 1: DRIVER NUDGE (10 min cadence, max 2 reminders) ──
      const nudgeable = await query(`
        SELECT * FROM dispatch_verifications
        WHERE status = 'pending'
          AND reminder_count < 2
          AND sent_at < NOW() - INTERVAL '10 minutes'
          AND (last_reminder_at IS NULL OR last_reminder_at < NOW() - INTERVAL '10 minutes')
      `);

      for (const v of nudgeable.rows) {
        const isSecond = v.reminder_count >= 1;
        const verifyUrl = `${BASE_URL}/verify/${v.token}`;

        const driverMsg = isSecond
          ? `Still waiting on your arrival confirmation for ${v.load_id}. If we don't hear back shortly, this load may move to another carrier. Confirm here: ${verifyUrl}`
          : `Reminder: ${v.load_id} — please confirm arrival at ${v.pickup_address.split(",")[0]} when you get there. Tap here: ${verifyUrl}`;

        const sent = await sendSms(v.driver_phone, driverMsg);
        if (sent) {
          await query(
            `UPDATE dispatch_verifications SET reminder_count = reminder_count + 1, last_reminder_at = NOW() WHERE id = $1`,
            [v.id]
          );
          console.error(`[NUDGE] Reminder ${v.reminder_count + 1} sent to ${v.driver_phone} for ${v.load_id}`);

          // On the second nudge, also alert the broker that the driver hasn't responded
          if (isSecond) {
            await sendSms(v.broker_phone, `⚠ No response from driver on ${v.load_id}. Two reminders sent — no arrival confirmation received.`);
            console.error(`[NUDGE] Broker alert sent for ${v.load_id} — driver unresponsive after 2 nudges`);
          }
        }
      }

      // ── JOB 2: NO-CONFIRMATION ALERT (before pickup window) ────
      // If there's a pickup window and we're within 15 min of it opening,
      // alert the broker if no confirmation has come in
      const preWindow = await query(`
        SELECT * FROM dispatch_verifications
        WHERE status = 'pending'
          AND no_confirm_alert_sent = FALSE
          AND pickup_window_start IS NOT NULL
      `);

      for (const v of preWindow.rows) {
        const windowStr = String(v.pickup_window_start).trim();
        const today = now.toISOString().split("T")[0];
        const windowDate = new Date(`${today} ${windowStr}`);
        if (isNaN(windowDate.getTime())) continue;

        const minsUntilWindow = (windowDate.getTime() - now.getTime()) / (1000 * 60);

        // Alert broker if pickup window opens within 15 minutes and no confirmation
        if (minsUntilWindow <= 15 && minsUntilWindow > -30) {
          const sent = await sendSms(
            v.broker_phone,
            `⛔ No arrival confirmation for ${v.load_id}. Pickup window ${minsUntilWindow > 0 ? `opens in ${Math.round(minsUntilWindow)} min` : "is now open"}. Driver has not confirmed — HOLD / CALL DRIVER.`
          );
          if (sent) {
            await query("UPDATE dispatch_verifications SET no_confirm_alert_sent = TRUE WHERE id = $1", [v.id]);
            console.error(`[NO-CONFIRM] Broker alert sent for ${v.load_id} — window approaching, no confirmation`);
          }
        }
      }

    } catch (err) {
      console.error("[REMINDER TIMER ERROR]", err);
    }
  }, 2 * 60 * 1000); // Every 2 minutes

}).catch(err => {
  console.error("DB init failed:", err);
  process.exit(1);
});
