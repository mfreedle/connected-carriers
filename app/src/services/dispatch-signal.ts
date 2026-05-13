/**
 * Dispatch signal service — sends driver arrival check.
 *
 * Per SPINE-0006, this creates a dispatch_verifications record,
 * geocodes the pickup address, and sends the driver an SMS.
 *
 * The driver confirmation page (GET/POST /verify/:token) is handled
 * by the MCP server which reads from the same shared DB.
 *
 * Called by:
 *   - POST /api/v2/loads/:slug/assign (when profile is dispatch-ready)
 */

import crypto from "crypto";
import { query } from "../db";
import { sendSms } from "../lib/sms";

const MCP_URL = process.env.MCP_SERVER_URL || "https://cc-mcp-server-production.up.railway.app";
const GOOGLE_GEOCODE_KEY = process.env.GOOGLE_GEOCODE_KEY || "";

// ── Geocode ────────────────────────────────────────────────────────

async function geocodeAddress(address: string): Promise<{ lat: number; lng: number } | null> {
  if (!GOOGLE_GEOCODE_KEY) {
    // Fallback to Nominatim (OSM)
    const encoded = encodeURIComponent(address);
    const url = `https://nominatim.openstreetmap.org/search?q=${encoded}&format=json&limit=1&countrycodes=us`;
    try {
      const res = await fetch(url, {
        headers: { "User-Agent": "ConnectedCarriers/1.0 dispatch-signal" },
        signal: AbortSignal.timeout(6000),
      });
      if (!res.ok) return null;
      const data = await res.json() as Array<{ lat: string; lon: string }>;
      if (!data.length) return null;
      return { lat: parseFloat(data[0].lat), lng: parseFloat(data[0].lon) };
    } catch { return null; }
  }

  const encoded = encodeURIComponent(address);
  const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encoded}&key=${GOOGLE_GEOCODE_KEY}`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(6000) });
    if (!res.ok) return null;
    const data = await res.json() as {
      status: string;
      results: Array<{ geometry: { location: { lat: number; lng: number } } }>;
    };
    if (data.status !== "OK" || !data.results.length) return null;
    return data.results[0].geometry.location;
  } catch { return null; }
}

// ── Input ──────────────────────────────────────────────────────────

export interface DispatchSignalInput {
  load_id: string;           // canonical load_id (e.g. HX-0512-A3B7)
  assignment_id: number;
  carrier_id: number;
  driver_phone: string;
  broker_phone: string;
  mc_number?: string;
  carrier_name?: string;
  pickup_address: string;    // exact address for geofence
  pickup_window_start?: string;
  pickup_window_end?: string;
  origin?: string;           // fallback if no pickup_address
}

// ── Result ─────────────────────────────────────────────────────────

export interface DispatchSignalResult {
  dispatch_verification_id: string;  // the generated load_id on dispatch_verifications
  token: string;
  verify_url: string;
  geocoded: boolean;
  sms_sent: boolean;
}

// ── Service ────────────────────────────────────────────────────────

export async function createDispatchSignal(input: DispatchSignalInput): Promise<DispatchSignalResult> {
  const { load_id, assignment_id, driver_phone, broker_phone,
          mc_number, carrier_name, pickup_address, pickup_window_start,
          pickup_window_end, origin } = input;

  if (!driver_phone) throw new Error("driver_phone is required for dispatch signal");
  if (!pickup_address && !origin) throw new Error("pickup_address or origin is required");

  const address = pickup_address || origin || "";
  const dispatchLoadId = `CC-${new Date().toISOString().slice(0, 10).replace(/-/g, "")}-${crypto.randomBytes(3).toString("hex").toUpperCase()}`;
  const token = crypto.randomBytes(32).toString("hex");

  // Geocode pickup address
  const coords = await geocodeAddress(address);

  // Create dispatch_verifications record (shared DB — MCP reads this for /verify/:token)
  await query(
    `INSERT INTO dispatch_verifications
     (load_id, token, driver_phone, broker_phone, mc_number,
      pickup_address, pickup_window_start, pickup_window_end,
      geo_center_lat, geo_center_lng, fmcsa_company)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [
      dispatchLoadId, token,
      driver_phone, broker_phone,
      mc_number || null, address,
      pickup_window_start || null, pickup_window_end || null,
      coords?.lat || null, coords?.lng || null,
      carrier_name || null,
    ]
  );

  // Driver arrival confirmation URL (served by MCP's /verify/:token route)
  const verifyUrl = `${MCP_URL}/verify/${token}`;

  // Send driver SMS
  const driverMsg = `${load_id} — pickup at ${address.split(",")[0]}.\nConfirm arrival when you get there: ${verifyUrl}\nThis request is time-sensitive.`;
  const smsResult = await sendSms(driver_phone, driverMsg);

  return {
    dispatch_verification_id: dispatchLoadId,
    token,
    verify_url: verifyUrl,
    geocoded: Boolean(coords),
    sms_sent: smsResult.sent,
  };
}
