import { Router, Request, Response } from "express";
import { query } from "../db";
import { h } from "../middleware/security";

const router = Router();

// ── GET /track/:token — driver opens link, sees acceptance page ───

router.get("/track/:token", async (req: Request, res: Response) => {
  const { token } = req.params;

  try {
    const result = await query(`
      SELECT dp.id, dp.load_reference, dp.driver_name, dp.tracking_status,
             dp.final_clearance_status, dp.pickup_address,
             ba.company_name as broker_company
      FROM dispatch_packets dp
      JOIN broker_accounts ba ON ba.id = dp.broker_account_id
      WHERE dp.tracking_token = $1
    `, [token]);

    if (!result.rows.length) {
      return res.send(trackingErrorPage("This tracking link is invalid or has expired."));
    }

    const packet = result.rows[0];

    if (packet.final_clearance_status === "cancelled") {
      return res.send(trackingErrorPage("This load has been cancelled."));
    }

    if (packet.tracking_status === "accepted") {
      return res.send(trackingAlreadyAcceptedPage(packet));
    }

    res.send(trackingAcceptPage(token, packet));
  } catch (err) {
    console.error("Tracking page error:", err);
    res.status(500).send(trackingErrorPage("Something went wrong. Please try again."));
  }
});

// ── POST /track/:token/accept — driver accepts tracking ───────────

router.post("/track/:token/accept", async (req: Request, res: Response) => {
  const { token } = req.params;

  try {
    const result = await query(`
      SELECT dp.id, dp.broker_account_id, dp.final_clearance_status,
             ba.company_name as broker_company
      FROM dispatch_packets dp
      JOIN broker_accounts ba ON ba.id = dp.broker_account_id
      WHERE dp.tracking_token = $1
    `, [token]);

    if (!result.rows.length) {
      return res.send(trackingErrorPage("This tracking link is invalid."));
    }

    const packet = result.rows[0];

    if (packet.final_clearance_status === "cancelled") {
      return res.send(trackingErrorPage("This load has been cancelled."));
    }

    await query(`
      UPDATE dispatch_packets
      SET tracking_status = 'accepted', tracking_accepted_at = NOW(), updated_at = NOW()
      WHERE id = $1
    `, [packet.id]);

    await query(`
      INSERT INTO activity_logs (subject_type, subject_id, actor_type, actor_id, action, metadata)
      VALUES ('dispatch_packet', $1, 'driver', NULL, 'tracking_accepted_by_driver', $2)
    `, [packet.id, JSON.stringify({ token: token.slice(0, 8) + "..." })]);

    res.send(trackingConfirmedPage(packet.broker_company));
  } catch (err) {
    console.error("Tracking accept error:", err);
    res.status(500).send(trackingErrorPage("Something went wrong. Please try again."));
  }
});

// ── POST /track/:token/reject — driver rejects tracking ───────────

router.post("/track/:token/reject", async (req: Request, res: Response) => {
  const { token } = req.params;

  try {
    const result = await query(`
      SELECT dp.id FROM dispatch_packets dp WHERE dp.tracking_token = $1
    `, [token]);

    if (!result.rows.length) return res.send(trackingErrorPage("Invalid link."));

    await query(`
      UPDATE dispatch_packets SET tracking_status = 'rejected', updated_at = NOW() WHERE id = $1
    `, [result.rows[0].id]);

    await query(`
      INSERT INTO activity_logs (subject_type, subject_id, actor_type, actor_id, action, metadata)
      VALUES ('dispatch_packet', $1, 'driver', NULL, 'tracking_rejected_by_driver', $2)
    `, [result.rows[0].id, JSON.stringify({ token: token.slice(0, 8) + "..." })]);

    res.send(trackingRejectedPage());
  } catch (err) {
    console.error("Tracking reject error:", err);
    res.status(500).send(trackingErrorPage("Something went wrong. Please try again."));
  }
});

export default router;

// ── Page helpers ──────────────────────────────────────────────────

const pageShell = (content: string) => `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
<title>Connected Carriers — Load Tracking</title>
<link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500&display=swap" rel="stylesheet">
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  :root { --slate:#1C2B3A; --amber:#C8892A; --amber2:#E09B35; --cream:#F7F5F0; --cream3:#E0DAD0; --muted:#6B7A8A; }
  body { font-family:'DM Sans',system-ui,sans-serif; background:var(--slate); min-height:100vh; display:flex; flex-direction:column; align-items:center; justify-content:center; padding:24px; color:#fff; }
  .card { background:rgba(255,255,255,0.06); border:1px solid rgba(255,255,255,0.1); border-radius:6px; padding:36px 32px; max-width:400px; width:100%; text-align:center; }
  .logo { font-size:15px; color:rgba(255,255,255,0.5); letter-spacing:0.05em; margin-bottom:28px; }
  .logo span { color:var(--amber); }
  .icon { font-size:44px; margin-bottom:18px; }
  h1 { font-size:22px; font-weight:500; margin-bottom:10px; line-height:1.3; }
  p { font-size:14px; color:rgba(255,255,255,0.65); line-height:1.7; margin-bottom:6px; }
  .detail { font-size:13px; color:rgba(255,255,255,0.4); margin-top:12px; }
  .btn { display:block; width:100%; padding:15px; border:none; border-radius:4px; font-family:inherit; font-size:16px; font-weight:500; cursor:pointer; margin-top:24px; transition:background 0.15s; }
  .btn-accept { background:var(--amber); color:var(--slate); }
  .btn-accept:hover { background:var(--amber2); }
  .btn-reject { background:rgba(255,255,255,0.08); color:rgba(255,255,255,0.5); font-size:13px; padding:11px; margin-top:10px; }
  .btn-reject:hover { background:rgba(255,255,255,0.12); }
  .powered { font-size:11px; color:rgba(255,255,255,0.2); margin-top:24px; }
</style>
</head>
<body>${content}</body>
</html>`;

function trackingAcceptPage(token: string, packet: Record<string, unknown>): string {
  return pageShell(`
<div class="card">
  <div class="logo">Connected<span>Carriers</span></div>
  <div class="icon">📍</div>
  <h1>Confirm GPS tracking</h1>
  <p>${h(String(packet.broker_company || "Your broker"))} requires real-time tracking for this load.</p>
  ${packet.load_reference ? `<p class="detail">Load: ${h(packet.load_reference)}</p>` : ""}
  ${packet.pickup_address ? `<p class="detail">${h(packet.pickup_address)}</p>` : ""}
  <form method="POST" action="/track/${h(token)}/accept">
    <button type="submit" class="btn btn-accept">✓ Accept tracking</button>
  </form>
  <form method="POST" action="/track/${h(token)}/reject">
    <button type="submit" class="btn btn-reject">I cannot accept tracking</button>
  </form>
</div>
<div class="powered">Powered by Connected Carriers · A HoneXAI product</div>`);
}

function trackingConfirmedPage(brokerCompany: unknown): string {
  return pageShell(`
<div class="card">
  <div class="logo">Connected<span>Carriers</span></div>
  <div class="icon">✓</div>
  <h1>Tracking confirmed</h1>
  <p>${h(String(brokerCompany || "Your broker"))} has been notified that you've accepted tracking.</p>
  <p class="detail">You're all set. Drive safe.</p>
</div>
<div class="powered">Powered by Connected Carriers · A HoneXAI product</div>`);
}

function trackingAlreadyAcceptedPage(packet: Record<string, unknown>): string {
  return pageShell(`
<div class="card">
  <div class="logo">Connected<span>Carriers</span></div>
  <div class="icon">✓</div>
  <h1>Already confirmed</h1>
  <p>Tracking was already accepted for this load.</p>
  ${packet.load_reference ? `<p class="detail">Load: ${h(packet.load_reference)}</p>` : ""}
</div>
<div class="powered">Powered by Connected Carriers · A HoneXAI product</div>`);
}

function trackingRejectedPage(): string {
  return pageShell(`
<div class="card">
  <div class="logo">Connected<span>Carriers</span></div>
  <div class="icon">✗</div>
  <h1>Tracking declined</h1>
  <p>Your broker has been notified. Contact them directly to discuss next steps.</p>
</div>
<div class="powered">Powered by Connected Carriers · A HoneXAI product</div>`);
}

function trackingErrorPage(message: string): string {
  return pageShell(`
<div class="card">
  <div class="logo">Connected<span>Carriers</span></div>
  <div class="icon">⚠</div>
  <h1>Link unavailable</h1>
  <p>${h(message)}</p>
</div>
<div class="powered">Powered by Connected Carriers · A HoneXAI product</div>`);
}
