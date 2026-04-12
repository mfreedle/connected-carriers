// ── Twilio SMS helper ─────────────────────────────────────────────
// Fail-safe: logs errors but never throws — SMS failure must never
// break the dispatch workflow or clearance operation.

interface SmsResult {
  sent: boolean;
  sid?: string;
  error?: string;
}

function isConfigured(): boolean {
  return !!(
    process.env.TWILIO_ACCOUNT_SID &&
    process.env.TWILIO_AUTH_TOKEN &&
    process.env.TWILIO_PHONE_NUMBER
  );
}

export async function sendSms(to: string, body: string): Promise<SmsResult> {
  if (!isConfigured()) {
    console.warn("[SMS] Twilio not configured — skipping send to", to);
    return { sent: false, error: "Twilio not configured" };
  }

  const accountSid = process.env.TWILIO_ACCOUNT_SID!;
  const authToken = process.env.TWILIO_AUTH_TOKEN!;
  const from = process.env.TWILIO_PHONE_NUMBER!;

  // Normalize phone — strip non-digits, ensure E.164
  const normalized = normalizePhone(to);
  if (!normalized) {
    console.warn("[SMS] Invalid phone number:", to);
    return { sent: false, error: "Invalid phone number" };
  }

  try {
    const https = await import("https");
    const qs = await import("querystring");

    const payload = qs.stringify({ To: normalized, From: from, Body: body });

    const result = await new Promise<{ sid: string }>((resolve, reject) => {
      const options = {
        hostname: "api.twilio.com",
        port: 443,
        path: `/2010-04-01/Accounts/${accountSid}/Messages.json`,
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "Content-Length": Buffer.byteLength(payload),
          "Authorization": "Basic " + Buffer.from(`${accountSid}:${authToken}`).toString("base64"),
        },
      };

      const req = https.request(options, (res) => {
        let data = "";
        res.on("data", (chunk) => data += chunk);
        res.on("end", () => {
          try {
            const parsed = JSON.parse(data);
            if (parsed.sid) resolve({ sid: parsed.sid });
            else reject(new Error(parsed.message || parsed.code || "Twilio error"));
          } catch {
            reject(new Error("Failed to parse Twilio response"));
          }
        });
      });

      req.on("error", reject);
      req.write(payload);
      req.end();
    });

    console.log(`[SMS] Sent to ${normalized} — SID: ${result.sid}`);
    return { sent: true, sid: result.sid };

  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[SMS] Send failed to ${normalized}:`, message);
    return { sent: false, error: message };
  }
}

function normalizePhone(phone: string): string | null {
  const digits = phone.replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  if (digits.length > 7) return `+${digits}`;
  return null;
}

export { isConfigured as isTwilioConfigured };
