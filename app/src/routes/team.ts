import { Router, Request, Response } from "express";
import crypto from "crypto";
import { query } from "../db";
import { AuthenticatedRequest, requireAuth, requireOwner } from "../middleware/auth";
import { h, csrfToken } from "../middleware/security";
import { layout } from "../views/layout";

const router = Router();

function hashPassword(password: string): string {
  return crypto.createHash("sha256").update(password + process.env.SESSION_SECRET).digest("hex");
}

// ── GET /team — team management page (owner only) ─────────────────

router.get("/team", requireAuth, requireOwner, async (req: AuthenticatedRequest, res: Response) => {
  const accountId = req.session.brokerAccountId!;
  const csrf = csrfToken(req);

  try {
    const usersRes = await query(`
      SELECT id, name, email, role, active, created_at
      FROM broker_users WHERE broker_account_id=$1 ORDER BY created_at ASC
    `, [accountId]);

    const invitesRes = await query(`
      SELECT bi.*, bu.name as invited_by_name
      FROM broker_invites bi
      JOIN broker_users bu ON bu.id = bi.invited_by
      WHERE bi.broker_account_id=$1 AND bi.accepted_at IS NULL AND bi.expires_at > NOW()
      ORDER BY bi.created_at DESC
    `, [accountId]);

    const BASE_URL = process.env.BASE_URL || "https://app.connectedcarriers.org";

    res.send(layout({
      title: "Team",
      userName: req.session.userName || "",
      csrfToken: csrf,
      content: teamContent(usersRes.rows, invitesRes.rows, csrf, BASE_URL, req.query),
    }));
  } catch (err) {
    console.error(err);
    res.status(500).send("Error loading team page");
  }
});

// ── POST /team/invite — send invite link (owner only) ─────────────

router.post("/team/invite", requireAuth, requireOwner, async (req: AuthenticatedRequest, res: Response) => {
  const accountId = req.session.brokerAccountId!;
  const userId = req.session.userId!;
  const { email, role } = req.body;

  if (!email?.trim()) return res.redirect("/team?error=email_required");
  if (!["owner", "ops", "reviewer"].includes(role)) return res.redirect("/team?error=invalid_role");

  try {
    // Check no existing active user with this email
    const existing = await query(`SELECT id FROM broker_users WHERE email=$1`, [email.trim().toLowerCase()]);
    if (existing.rows.length) return res.redirect("/team?error=email_already_exists");

    const token = crypto.randomBytes(32).toString("hex");

    await query(`
      INSERT INTO broker_invites (broker_account_id, email, role, token, invited_by)
      VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (token) DO NOTHING
    `, [accountId, email.trim().toLowerCase(), role, token, userId]);

    res.redirect(`/team?invited=1`);
  } catch (err) {
    console.error(err);
    res.redirect("/team?error=invite_failed");
  }
});

// ── POST /team/users/:id/deactivate — deactivate user (owner only) ─

router.post("/team/users/:id/deactivate", requireAuth, requireOwner, async (req: AuthenticatedRequest, res: Response) => {
  const accountId = req.session.brokerAccountId!;
  const targetId = parseInt(req.params.id);

  // Cannot deactivate yourself
  if (targetId === req.session.userId) return res.redirect("/team?error=cannot_deactivate_self");

  try {
    await query(`UPDATE broker_users SET active=false, updated_at=NOW() WHERE id=$1 AND broker_account_id=$2`, [targetId, accountId]);
    res.redirect("/team?saved=user_deactivated");
  } catch (err) {
    console.error(err);
    res.redirect("/team?error=deactivate_failed");
  }
});

// ── POST /team/users/:id/reactivate ───────────────────────────────

router.post("/team/users/:id/reactivate", requireAuth, requireOwner, async (req: AuthenticatedRequest, res: Response) => {
  const accountId = req.session.brokerAccountId!;
  const targetId = parseInt(req.params.id);
  try {
    await query(`UPDATE broker_users SET active=true, updated_at=NOW() WHERE id=$1 AND broker_account_id=$2`, [targetId, accountId]);
    res.redirect("/team?saved=user_reactivated");
  } catch (err) {
    console.error(err);
    res.redirect("/team?error=reactivate_failed");
  }
});

// ── POST /team/users/:id/reset-password — owner resets another user's password ─

router.post("/team/users/:id/reset-password", requireAuth, requireOwner, async (req: AuthenticatedRequest, res: Response) => {
  const accountId = req.session.brokerAccountId!;
  const targetId = parseInt(req.params.id);
  const { new_password } = req.body;

  if (!new_password || new_password.length < 8) return res.redirect("/team?error=password_too_short");

  try {
    const digest = hashPassword(new_password);
    await query(`UPDATE broker_users SET password_digest=$1, updated_at=NOW() WHERE id=$2 AND broker_account_id=$3`, [digest, targetId, accountId]);
    res.redirect("/team?saved=password_reset");
  } catch (err) {
    console.error(err);
    res.redirect("/team?error=reset_failed");
  }
});

// ── GET /team/accept/:token — invite acceptance page (public) ──────

router.get("/team/accept/:token", async (req: Request, res: Response) => {
  const { token } = req.params;
  try {
    const inviteRes = await query(`
      SELECT bi.*, ba.company_name
      FROM broker_invites bi
      JOIN broker_accounts ba ON ba.id = bi.broker_account_id
      WHERE bi.token=$1 AND bi.accepted_at IS NULL AND bi.expires_at > NOW()
    `, [token]);

    if (!inviteRes.rows.length) {
      return res.send(inviteErrorPage("This invitation link is invalid or has expired."));
    }

    const invite = inviteRes.rows[0];
    res.send(inviteAcceptPage(token, invite, req.query));
  } catch (err) {
    console.error(err);
    res.status(500).send(inviteErrorPage("Something went wrong."));
  }
});

// ── POST /team/accept/:token — create account from invite ─────────

router.post("/team/accept/:token", async (req: Request, res: Response) => {
  const { token } = req.params;
  const { name, password, password_confirm } = req.body;

  if (!name?.trim()) return res.redirect(`/team/accept/${token}?error=name_required`);
  if (!password || password.length < 8) return res.redirect(`/team/accept/${token}?error=password_too_short`);
  if (password !== password_confirm) return res.redirect(`/team/accept/${token}?error=passwords_dont_match`);

  try {
    const inviteRes = await query(`
      SELECT * FROM broker_invites
      WHERE token=$1 AND accepted_at IS NULL AND expires_at > NOW()
    `, [token]);

    if (!inviteRes.rows.length) return res.send(inviteErrorPage("This invitation has expired or already been used."));
    const invite = inviteRes.rows[0];

    // Check email not already taken
    const existing = await query(`SELECT id FROM broker_users WHERE email=$1`, [invite.email]);
    if (existing.rows.length) return res.redirect(`/team/accept/${token}?error=email_already_exists`);

    const digest = hashPassword(password);

    await query(`
      INSERT INTO broker_users (broker_account_id, name, email, password_digest, role)
      VALUES ($1, $2, $3, $4, $5)
    `, [invite.broker_account_id, name.trim(), invite.email, digest, invite.role]);

    await query(`UPDATE broker_invites SET accepted_at=NOW() WHERE token=$1`, [token]);

    res.send(inviteAcceptedPage(invite.company_name));
  } catch (err) {
    console.error(err);
    res.redirect(`/team/accept/${token}?error=accept_failed`);
  }
});

export default router;

// ── Views ─────────────────────────────────────────────────────────

function teamContent(
  users: Record<string, unknown>[],
  pendingInvites: Record<string, unknown>[],
  csrf: string,
  BASE_URL: string,
  qs: Record<string, unknown>
): string {
  const savedMsg: Record<string, string> = {
    user_deactivated: "User deactivated.",
    user_reactivated: "User reactivated.",
    password_reset: "Password updated.",
    invited_1: "Invite link generated.",
  };
  const errorMsg: Record<string, string> = {
    email_required: "Email is required.",
    invalid_role: "Invalid role.",
    email_already_exists: "A user with that email already exists.",
    invite_failed: "Could not generate invite.",
    cannot_deactivate_self: "You cannot deactivate your own account.",
    password_too_short: "Password must be at least 8 characters.",
    passwords_dont_match: "Passwords do not match.",
    reset_failed: "Password reset failed.",
    deactivate_failed: "Deactivation failed.",
  };

  const saved = qs.saved ? savedMsg[String(qs.saved)] : qs.invited ? "Invite link generated." : null;
  const error = qs.error ? errorMsg[String(qs.error)] : null;

  const roleBadge = (role: string) => {
    const colors: Record<string, string> = { owner: "#C8892A", ops: "#3b82f6", reviewer: "#6b7a8a" };
    const c = colors[role] || "#6b7a8a";
    return `<span class="badge" style="background:${c}20;color:${c};border:1px solid ${c}40">${h(role)}</span>`;
  };

  return `
<div style="max-width:720px">
  <h1 style="font-family:var(--serif);font-size:28px;font-weight:400;margin-bottom:24px">Team</h1>

  ${saved ? `<div class="alert alert-success">✓ ${h(saved)}</div>` : ""}
  ${error ? `<div class="alert alert-error">${h(error)}</div>` : ""}

  <!-- Current users -->
  <div class="card" style="margin-bottom:16px">
    <div class="card-title">Team members</div>
    <table style="width:100%;border-collapse:collapse;font-size:13px">
      <thead>
        <tr style="border-bottom:1px solid var(--cream3)">
          <th style="text-align:left;padding:8px 0;color:var(--muted);font-weight:500">Name</th>
          <th style="text-align:left;padding:8px 0;color:var(--muted);font-weight:500">Email</th>
          <th style="text-align:left;padding:8px 0;color:var(--muted);font-weight:500">Role</th>
          <th style="text-align:left;padding:8px 0;color:var(--muted);font-weight:500">Status</th>
          <th style="padding:8px 0"></th>
        </tr>
      </thead>
      <tbody>
        ${users.map((u: Record<string, unknown>) => `
        <tr style="border-bottom:1px solid var(--cream2)">
          <td style="padding:10px 0">${h(u.name)}</td>
          <td style="padding:10px 0;color:var(--muted)">${h(u.email)}</td>
          <td style="padding:10px 0">${roleBadge(String(u.role))}</td>
          <td style="padding:10px 0">
            <span style="font-size:11px;color:${u.active ? "#10b981" : "#6b7a8a"}">${u.active ? "Active" : "Inactive"}</span>
          </td>
          <td style="padding:10px 0;text-align:right">
            <div style="display:flex;gap:6px;justify-content:flex-end;align-items:center">
              <!-- Reset password -->
              <button onclick="document.getElementById('reset-${h(u.id)}').style.display=document.getElementById('reset-${h(u.id)}').style.display==='none'?'block':'none'" class="btn-sm" style="font-size:11px">Reset pw</button>
              <!-- Deactivate/reactivate -->
              ${u.active ? `
              <form method="POST" action="/team/users/${h(u.id)}/deactivate">
                <input type="hidden" name="_csrf" value="${h(csrf)}">
                <button type="submit" class="btn-sm" style="font-size:11px;background:var(--cream);color:var(--muted)">Deactivate</button>
              </form>` : `
              <form method="POST" action="/team/users/${h(u.id)}/reactivate">
                <input type="hidden" name="_csrf" value="${h(csrf)}">
                <button type="submit" class="btn-sm" style="font-size:11px">Reactivate</button>
              </form>`}
            </div>
            <!-- Reset password inline form -->
            <div id="reset-${h(u.id)}" style="display:none;margin-top:8px">
              <form method="POST" action="/team/users/${h(u.id)}/reset-password" style="display:flex;gap:6px;align-items:center;flex-wrap:wrap">
                <input type="hidden" name="_csrf" value="${h(csrf)}">
                <input type="password" name="new_password" placeholder="New password (8+ chars)" style="font-size:12px;padding:5px 8px;border:1px solid var(--cream3);border-radius:2px;font-family:var(--sans)">
                <button type="submit" class="btn-sm" style="font-size:11px">Save</button>
              </form>
            </div>
          </td>
        </tr>`).join("")}
      </tbody>
    </table>
  </div>

  <!-- Pending invites -->
  ${pendingInvites.length > 0 ? `
  <div class="card" style="margin-bottom:16px">
    <div class="card-title">Pending invitations</div>
    ${pendingInvites.map((inv: Record<string, unknown>) => {
      const inviteUrl = `${BASE_URL}/team/accept/${h(inv.token)}`;
      return `
    <div style="padding:10px 0;border-bottom:1px solid var(--cream2);font-size:13px">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">
        <span>${h(inv.email)} ${roleBadge(String(inv.role))}</span>
        <span style="font-size:11px;color:var(--muted)">Invited by ${h(inv.invited_by_name)} · expires ${new Date(String(inv.expires_at)).toLocaleDateString()}</span>
      </div>
      <div style="display:flex;gap:6px;align-items:center">
        <code style="font-size:10px;background:var(--cream);border:1px solid var(--cream3);padding:4px 6px;border-radius:2px;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${inviteUrl}</code>
        <button onclick="navigator.clipboard.writeText('${inviteUrl}').then(()=>this.textContent='Copied!').catch(()=>{})" class="btn-sm" style="font-size:11px;white-space:nowrap">Copy link</button>
      </div>
    </div>`;
    }).join("")}
  </div>` : ""}

  <!-- Invite new member -->
  <div class="card">
    <div class="card-title">Invite a team member</div>
    <p style="font-size:13px;color:var(--muted);margin-bottom:14px">Generates a 7-day invite link. Send it to the person you want to add.</p>
    <form method="POST" action="/team/invite" style="display:flex;gap:10px;flex-wrap:wrap;align-items:flex-end">
      <input type="hidden" name="_csrf" value="${h(csrf)}">
      <div>
        <label style="display:block;font-size:11px;font-weight:500;text-transform:uppercase;letter-spacing:0.07em;color:var(--muted);margin-bottom:4px">Email</label>
        <input type="email" name="email" required placeholder="assistant@logisticsxpress.com" style="padding:8px 10px;border:1px solid var(--cream3);border-radius:2px;font-size:13px;font-family:var(--sans);min-width:240px">
      </div>
      <div>
        <label style="display:block;font-size:11px;font-weight:500;text-transform:uppercase;letter-spacing:0.07em;color:var(--muted);margin-bottom:4px">Role</label>
        <select name="role" style="padding:8px 10px;border:1px solid var(--cream3);border-radius:2px;font-size:13px;font-family:var(--sans)">
          <option value="reviewer">Reviewer — can view and review carriers</option>
          <option value="ops">Ops — can manage carriers and dispatch</option>
          <option value="owner">Owner — full access including team management</option>
        </select>
      </div>
      <button type="submit" class="btn-primary">Generate invite link</button>
    </form>
  </div>

  <div style="margin-top:12px;font-size:12px;color:var(--muted)">
    <strong>Roles:</strong> Reviewer can view and add notes. Ops can manage carriers and dispatch packets. Owner has full access including team and settings.
  </div>
</div>`;
}

// ── Invite acceptance pages ───────────────────────────────────────

const pageShell = (content: string) => `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Connected Carriers — Join your team</title>
<link href="https://fonts.googleapis.com/css2?family=Playfair+Display:wght@400&family=DM+Sans:wght@400;500&display=swap" rel="stylesheet">
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  :root { --slate:#1C2B3A; --amber:#C8892A; --cream:#F7F5F0; --cream3:#E0DAD0; --muted:#6B7A8A; }
  body { font-family:'DM Sans',system-ui,sans-serif; background:var(--slate); min-height:100vh; display:flex; flex-direction:column; align-items:center; justify-content:center; padding:24px; }
  .card { background:white; border-radius:4px; padding:36px 32px; max-width:440px; width:100%; }
  .logo { font-family:'Playfair Display',serif; font-size:18px; color:rgba(255,255,255,0.5); margin-bottom:28px; text-align:center; }
  .logo span { color:var(--amber); }
  h1 { font-family:'Playfair Display',serif; font-size:24px; font-weight:400; color:var(--slate); margin-bottom:8px; }
  .sub { font-size:14px; color:var(--muted); margin-bottom:24px; }
  .field { margin-bottom:14px; }
  label { display:block; font-size:11px; font-weight:500; letter-spacing:0.07em; text-transform:uppercase; color:var(--muted); margin-bottom:4px; }
  input { width:100%; padding:10px 12px; border:1px solid var(--cream3); border-radius:2px; font-size:14px; font-family:inherit; }
  input:focus { outline:2px solid var(--amber); border-color:var(--amber); }
  .btn { width:100%; padding:12px; background:var(--amber); color:var(--slate); border:none; border-radius:2px; font-family:inherit; font-size:14px; font-weight:500; cursor:pointer; margin-top:8px; }
  .alert-error { background:#fef2f2; color:#b91c1c; border:1px solid #fecaca; padding:10px 14px; border-radius:2px; font-size:13px; margin-bottom:14px; }
  .meta { font-size:12px; color:var(--muted); margin-top:8px; }
</style>
</head>
<body>
<div class="logo">Connected<span>Carriers</span></div>
${content}
</body>
</html>`;

function inviteAcceptPage(token: string, invite: Record<string, unknown>, qs: Record<string, unknown>): string {
  const errorMsg: Record<string, string> = {
    name_required: "Please enter your name.",
    password_too_short: "Password must be at least 8 characters.",
    passwords_dont_match: "Passwords don't match.",
    email_already_exists: "An account with this email already exists.",
    accept_failed: "Something went wrong. Please try again.",
  };
  const error = qs.error ? errorMsg[String(qs.error)] : null;

  return pageShell(`
<div class="card">
  <h1>Join ${h(invite.company_name)}</h1>
  <p class="sub">You've been invited as a <strong>${h(invite.role)}</strong>. Create your account to get started.</p>
  ${error ? `<div class="alert-error">${h(error)}</div>` : ""}
  <form method="POST" action="/team/accept/${h(token)}">
    <div class="field">
      <label>Your name</label>
      <input type="text" name="name" required placeholder="First Last" autocomplete="name">
    </div>
    <div class="field">
      <label>Email</label>
      <input type="email" value="${h(invite.email)}" disabled style="background:var(--cream);color:var(--muted)">
    </div>
    <div class="field">
      <label>Password</label>
      <input type="password" name="password" required placeholder="8+ characters" autocomplete="new-password">
    </div>
    <div class="field">
      <label>Confirm password</label>
      <input type="password" name="password_confirm" required placeholder="Repeat password" autocomplete="new-password">
    </div>
    <button type="submit" class="btn">Create account →</button>
  </form>
  <p class="meta">This invitation expires ${new Date(String(invite.expires_at)).toLocaleDateString()}.</p>
</div>`);
}

function inviteAcceptedPage(companyName: unknown): string {
  return pageShell(`
<div class="card" style="text-align:center">
  <div style="font-size:40px;margin-bottom:16px">✓</div>
  <h1 style="margin-bottom:8px">You're in.</h1>
  <p class="sub">Your account has been created for ${h(String(companyName || "your team"))}.</p>
  <a href="/login" style="display:block;width:100%;padding:12px;background:var(--amber);color:var(--slate);border-radius:2px;text-decoration:none;font-weight:500;margin-top:8px;text-align:center">Go to login →</a>
</div>`);
}

function inviteErrorPage(message: string): string {
  return pageShell(`
<div class="card" style="text-align:center">
  <div style="font-size:40px;margin-bottom:16px">⚠</div>
  <h1 style="margin-bottom:8px">Link unavailable</h1>
  <p class="sub">${h(message)}</p>
</div>`);
}
