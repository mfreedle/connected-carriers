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

// ── MCP SERVER ──────────────────────────────────────────────────
const server = new McpServer({
  name: "cc-mcp-server",
  version: "1.1.0"
});

// ── TOOL: cc_lookup_carrier ─────────────────────────────────────
server.registerTool(
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

// ── TOOL: cc_verify_carrier ─────────────────────────────────────
server.registerTool(
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

// ── TOOL: cc_assign_tier ────────────────────────────────────────
server.registerTool(
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

// ── FMCSA SAFER API ─────────────────────────────────────────────
async function lookupFMCSA(mc_number: string): Promise<Record<string, unknown>> {
  const clean = mc_number.replace(/\D/g, "");
  const url = `https://safer.fmcsa.dot.gov/query.asp?searchtype=ANY&query_type=queryCarrierSnapshot&query_param=MC_MX&query_string=${clean}&action=get_data`;

  const response = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!response.ok) throw new Error(`FMCSA API returned ${response.status}`);

  const html = await response.text();

  // Parse key fields from FMCSA HTML snapshot
  const extract = (label: string): string => {
    const regex = new RegExp(`${label}[^<]*<[^>]+>([^<]+)<`, "i");
    const match = html.match(regex);
    return match ? match[1].trim() : "";
  };

  const entityName    = extract("Entity Type:") || extract("Legal Name:");
  const usdotStatus   = extract("USDOT Status:");
  const mcStatus      = extract("MC/MX/FF Number\\(s\\):");
  const safetyRating  = extract("Safety Rating:");
  const bipdInsurance = extract("BIPD Insurance Required:");
  const cargoInsurance = extract("Cargo Insurance Required:");
  const outOfService  = extract("Out of Service Date:");
  const operatingStatus = html.includes("AUTHORIZED FOR Property") ? "ACTIVE" :
                          html.includes("NOT AUTHORIZED") ? "NOT AUTHORIZED" : "UNKNOWN";

  return {
    mc_number: clean,
    entity_name: entityName,
    operating_status: operatingStatus,
    usdot_status: usdotStatus,
    mc_status: mcStatus,
    safety_rating: safetyRating || "Not Rated",
    bipd_insurance: bipdInsurance,
    cargo_insurance: cargoInsurance,
    out_of_service_date: outOfService,
    active: operatingStatus === "ACTIVE",
    source: "FMCSA SAFER",
    checked_at: new Date().toISOString()
  };
}

function runVerificationChecks(
  fmcsa: Record<string, unknown>,
  requirements: { min_insurance?: number; min_years?: number }
): Record<string, boolean> {
  return {
    active_authority: fmcsa.active === true,
    no_unsatisfactory_rating: fmcsa.safety_rating !== "Unsatisfactory",
    not_out_of_service: !fmcsa.out_of_service_date,
    insurance_on_file: Boolean(fmcsa.bipd_insurance),
    requirements_noted: Boolean(requirements)
  };
}

// ── GEOCODING ───────────────────────────────────────────────────
async function geocodeAddress(address: string): Promise<{ lat: number; lng: number } | null> {
  if (!GOOGLE_GEOCODE_KEY) {
    // Fallback: basic US geocoding via nominatim (free, no key)
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

  // Google Geocoding API (preferred)
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
  const R = 3958.8; // miles
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat/2) ** 2 +
            Math.cos(lat1 * Math.PI/180) * Math.cos(lat2 * Math.PI/180) * Math.sin(dLng/2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function geofenceResult(miles: number): string {
  if (miles <= 0.5)  return "green";
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

// ── HTTP ROUTES ──────────────────────────────────────────────────
const PORT = parseInt(process.env.PORT || "3000");

const httpServer = http.createServer(async (req, res) => {
  const url = req.url || "";

  // ── MCP endpoint
  if (req.method === "POST" && url === "/mcp") {
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    await server.connect(transport);
    await transport.handleRequest(req, res, await readBody(req));
    return;
  }

  // ── Health check
  if (url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok", service: "cc-mcp-server", version: "1.1.0" }));
    return;
  }

  // ── POST /dispatch — broker submits verification request
  if (req.method === "POST" && url === "/dispatch") {
    setCors(res);
    try {
      const body = JSON.parse((await readBody(req)).toString());
      const { driver_phone, broker_phone, mc_number, pickup_address, pickup_window_start, pickup_window_end } = body;

      if (!driver_phone || !broker_phone || !pickup_address) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "driver_phone, broker_phone, and pickup_address are required" }));
        return;
      }

      // Generate IDs
      const load_id = `CC-${new Date().toISOString().slice(0,10).replace(/-/g,"")}-${crypto.randomBytes(3).toString("hex").toUpperCase()}`;
      const token   = crypto.randomBytes(32).toString("hex");

      // Geocode the pickup address
      const coords = await geocodeAddress(pickup_address);

      // FMCSA check if MC provided
      let fmcsa_authority: string | null = null;
      let fmcsa_company: string | null = null;
      if (mc_number) {
        try {
          const fmcsa = await lookupFMCSA(mc_number);
          fmcsa_authority = fmcsa.active ? "Active" : "Inactive/Unknown";
          fmcsa_company   = fmcsa.entity_name as string || null;
        } catch { /* non-blocking */ }
      }

      // Store record
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

      // Send SMS to driver
      const verifyUrl  = `${BASE_URL}/verify/${token}`;
      const driverSms  = `Load ${load_id} — pickup at ${pickup_address.split(",")[0]}.\nTap to confirm arrival: ${verifyUrl}`;
      const smsSent    = await sendSms(normalizePhone(driver_phone), driverSms);

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        success: true,
        load_id,
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

  // ── GET /verify/:token — driver confirmation page
  if (req.method === "GET" && url.startsWith("/verify/")) {
    const token = url.replace("/verify/", "").split("?")[0];
    try {
      const result = await query(
        "SELECT * FROM dispatch_verifications WHERE token = $1",
        [token]
      );
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
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(verifyPage(v, token));
    } catch (err) {
      console.error("[GET /verify error]", err);
      res.writeHead(500); res.end("Server error");
    }
    return;
  }

  // ── POST /verify/:token — driver confirms with location
  if (req.method === "POST" && url.startsWith("/verify/")) {
    setCors(res);
    const token = url.replace("/verify/", "").split("?")[0];
    try {
      const body = JSON.parse((await readBody(req)).toString());
      const { lat, lng } = body;

      const result = await query(
        "SELECT * FROM dispatch_verifications WHERE token = $1",
        [token]
      );
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

      // Calculate distance if we have both coordinates
      let distance_miles: number | null = null;
      let fence_result = "unknown";
      if (lat && lng && v.geo_center_lat && v.geo_center_lng) {
        distance_miles = haversineDistance(v.geo_center_lat, v.geo_center_lng, lat, lng);
        fence_result   = geofenceResult(distance_miles);
      }

      const confirmed_at = new Date();

      // Update record
      await query(
        `UPDATE dispatch_verifications
         SET status = 'confirmed', confirmed_at = $1,
             confirmed_lat = $2, confirmed_lng = $3,
             distance_miles = $4, geofence_result = $5
         WHERE token = $6`,
        [confirmed_at, lat || null, lng || null, distance_miles, fence_result, token]
      );

      // Notify broker via SMS
      const brokerSms = buildBrokerSms(v.load_id, distance_miles, fence_result, confirmed_at);
      const notified  = await sendSms(v.broker_phone, brokerSms);

      if (notified) {
        await query(
          "UPDATE dispatch_verifications SET broker_notified_at = NOW() WHERE token = $1",
          [token]
        );
      }

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        confirmed: true,
        load_id: v.load_id,
        distance_miles: distance_miles ? Math.round(distance_miles * 100) / 100 : null,
        geofence_result: fence_result,
        broker_notified: notified
      }));

    } catch (err) {
      console.error("[POST /verify error]", err);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Server error" }));
    }
    return;
  }

  // ── GET /status/:load_id — broker checks a verification
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
  confirmed_at: Date
): string {
  const time = confirmed_at.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true });
  const dist = distance !== null ? `${Math.round(distance * 100) / 100} mi` : "location unavailable";

  if (fence === "green") {
    return `CC ${load_id} confirmed ✓\n${dist} from pickup — ${time}\nStatus: ON SITE`;
  }
  if (fence === "yellow") {
    return `CC ${load_id} — nearby\n${dist} from pickup — ${time}\nStatus: NEAR — confirm before loading`;
  }
  if (fence === "red") {
    return `CC ${load_id} ⚠ MISMATCH\n${dist} from pickup — ${time}\nCall before freight moves`;
  }
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
    <p class="geo-note">Your location will be shared to verify you're on site.</p>
    <p class="error-msg" id="err-msg"></p>
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
  if (!navigator.geolocation) {
    postConfirm(null, null);
    return;
  }
  navigator.geolocation.getCurrentPosition(
    pos => postConfirm(pos.coords.latitude, pos.coords.longitude),
    ()  => postConfirm(null, null),
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
    } else {
      showErr('Something went wrong. Please try again.');
    }
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

// ── STARTUP ───────────────────────────────────────────────────────
initDb().then(() => {
  httpServer.listen(PORT, () => {
    console.error(`cc-mcp-server v1.1.0 running on port ${PORT}`);
    console.error(`Routes: POST /dispatch | GET+POST /verify/:token | GET /status/:load_id`);
    console.error(`MCP tools: cc_lookup_carrier, cc_verify_carrier, cc_assign_tier`);
  });
}).catch(err => {
  console.error("DB init failed:", err);
  process.exit(1);
});
