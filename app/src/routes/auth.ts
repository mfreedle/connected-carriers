import { Router, Request, Response } from "express";
import bcrypt from "bcryptjs";
import crypto from "crypto";
import { query } from "../db";
import { sendSms } from "../lib/sms";
import { AuthenticatedRequest } from "../middleware/auth";

const router = Router();

// ── Sign in ───────────────────────────────────────────────────────

router.get("/login", (req: Request, res: Response) => {
  const session = (req as AuthenticatedRequest).session;
  if (session?.userId) return res.redirect("/loads");
  res.send(loginPage());
});

router.post("/login", async (req: Request, res: Response) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.send(loginPage("Email and password required."));
  }
  try {
    const result = await query(
      `SELECT bu.*, ba.company_name FROM broker_users bu
       JOIN broker_accounts ba ON ba.id = bu.broker_account_id
       WHERE bu.email = $1 AND bu.active = true`,
      [email.toLowerCase().trim()]
    );
    if (!result.rows.length) {
      return res.send(loginPage("Invalid email or password."));
    }
    const user = result.rows[0];
    const valid = await bcrypt.compare(password, user.password_digest);
    if (!valid) {
      return res.send(loginPage("Invalid email or password."));
    }
    const session = (req as AuthenticatedRequest).session;
    session.userId = user.id;
    session.brokerAccountId = user.broker_account_id;
    session.userRole = user.role;
    session.userName = user.name;
    session.userEmail = user.email;
    res.redirect("/loads");
  } catch (err) {
    console.error(err);
    res.send(loginPage("Something went wrong. Try again."));
  }
});

router.post("/logout", (req: Request, res: Response) => {
  req.session.destroy(() => res.redirect("/login"));
});

// ── Forgot password — Step 1: enter email ─────────────────────────

router.get("/forgot-password", (_req: Request, res: Response) => {
  res.send(forgotPasswordPage());
});

router.post("/forgot-password", async (req: Request, res: Response) => {
  const { email } = req.body;
  if (!email) {
    return res.send(forgotPasswordPage("Enter your email address."));
  }

  try {
    // Look up user + broker account to get phone
    const result = await query(
      `SELECT bu.id, bu.name, bu.email, ba.contact_phone
       FROM broker_users bu
       JOIN broker_accounts ba ON ba.id = bu.broker_account_id
       WHERE bu.email = $1 AND bu.active = true`,
      [email.toLowerCase().trim()]
    );

    if (!result.rows.length) {
      // Don't reveal whether the email exists — show same page either way
      return res.send(codeSentPage(email));
    }

    const user = result.rows[0];
    const phone = user.contact_phone;

    if (!phone) {
      return res.send(forgotPasswordPage("No phone number on file for this account. Contact support."));
    }

    // Rate limit: max 3 reset codes per user per hour
    const recentCodes = await query(
      `SELECT COUNT(*) as count FROM password_reset_codes
       WHERE user_id = $1 AND created_at > NOW() - INTERVAL '1 hour'`,
      [user.id]
    );
    if (parseInt(recentCodes.rows[0].count) >= 3) {
      return res.send(forgotPasswordPage("Too many attempts. Please wait an hour and try again."));
    }

    // Generate 6-digit code
    const code = String(crypto.randomInt(100000, 999999));
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000); // 15 minutes

    // Invalidate any existing unused codes for this user
    await query(
      `UPDATE password_reset_codes SET used = true WHERE user_id = $1 AND used = false`,
      [user.id]
    );

    // Store the code
    await query(
      `INSERT INTO password_reset_codes (user_id, code, phone, expires_at)
       VALUES ($1, $2, $3, $4)`,
      [user.id, code, phone, expiresAt]
    );

    // Send SMS
    const smsResult = await sendSms(phone, `Connected Carriers: Your verification code is ${code}. Expires in 15 minutes.`);

    if (!smsResult.sent) {
      console.error("[AUTH] SMS send failed for password reset:", smsResult.error);
      return res.send(forgotPasswordPage("Unable to send verification code. Please try again."));
    }

    // Mask phone for display
    const digits = phone.replace(/\D/g, "");
    const maskedPhone = "\u2022\u2022\u2022-\u2022\u2022\u2022-" + digits.slice(-4);

    res.send(enterCodePage(email, maskedPhone));

  } catch (err) {
    console.error("[AUTH] Forgot password error:", err);
    res.send(forgotPasswordPage("Something went wrong. Please try again."));
  }
});

// ── Forgot password — Step 2: enter code + new password ───────────

router.post("/verify-code", async (req: Request, res: Response) => {
  const { email, code, new_password, confirm_password } = req.body;

  if (!email || !code || !new_password) {
    return res.send(enterCodePage(email || "", "", "All fields are required."));
  }

  if (new_password.length < 8) {
    return res.send(enterCodePage(email, "", "Password must be at least 8 characters."));
  }

  if (new_password !== confirm_password) {
    return res.send(enterCodePage(email, "", "Passwords don't match."));
  }

  try {
    // Look up user
    const userResult = await query(
      `SELECT bu.id FROM broker_users bu WHERE bu.email = $1 AND bu.active = true`,
      [email.toLowerCase().trim()]
    );

    if (!userResult.rows.length) {
      return res.send(enterCodePage(email, "", "Invalid request."));
    }

    const userId = userResult.rows[0].id;

    // Find valid code
    const codeResult = await query(
      `SELECT id, attempts FROM password_reset_codes
       WHERE user_id = $1 AND code = $2 AND used = false AND expires_at > NOW()
       ORDER BY created_at DESC LIMIT 1`,
      [userId, code.trim()]
    );

    if (!codeResult.rows.length) {
      // Increment attempt counter on most recent code to prevent brute force
      await query(
        `UPDATE password_reset_codes SET attempts = attempts + 1
         WHERE user_id = $1 AND used = false AND expires_at > NOW()`,
        [userId]
      );

      // Check if too many bad attempts
      const latestCode = await query(
        `SELECT attempts FROM password_reset_codes
         WHERE user_id = $1 AND used = false AND expires_at > NOW()
         ORDER BY created_at DESC LIMIT 1`,
        [userId]
      );

      if (latestCode.rows.length && latestCode.rows[0].attempts >= 5) {
        await query(
          `UPDATE password_reset_codes SET used = true WHERE user_id = $1`,
          [userId]
        );
        return res.send(forgotPasswordPage("Too many incorrect attempts. Please request a new code."));
      }

      return res.send(enterCodePage(email, "", "Invalid or expired code. Please try again."));
    }

    // Code is valid — set the new password
    const hash = await bcrypt.hash(new_password, 12);
    await query("UPDATE broker_users SET password_digest = $1, updated_at = NOW() WHERE id = $2", [hash, userId]);

    // Mark code as used
    await query("UPDATE password_reset_codes SET used = true WHERE id = $1", [codeResult.rows[0].id]);

    res.send(passwordSetSuccessPage());

  } catch (err) {
    console.error("[AUTH] Verify code error:", err);
    res.send(enterCodePage(email || "", "", "Something went wrong. Please try again."));
  }
});

export default router;


// ── Page templates ────────────────────────────────────────────────

function authShell(title: string, body: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${title} — Connected Carriers</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Playfair+Display:wght@400;600&family=DM+Sans:wght@300;400;500&display=swap" rel="stylesheet">
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  :root {
    --slate: #1C2B3A; --slate2: #243447; --amber: #C8892A; --amber2: #E09B35;
    --cream: #F7F5F0; --cream2: #EDE9E1; --ink: #141414; --muted: #6B7A8A;
    --serif: 'Playfair Display', Georgia, serif;
    --sans: 'DM Sans', system-ui, sans-serif;
  }
  body { font-family: var(--sans); background: var(--slate); min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 24px; }
  .card { background: var(--cream); border-radius: 4px; padding: 48px 44px; width: 100%; max-width: 420px; }
  .wordmark { font-family: var(--serif); font-size: 22px; color: var(--slate); margin-bottom: 8px; }
  .wordmark span { color: var(--amber); }
  .subtitle { font-size: 13px; color: var(--muted); letter-spacing: 0.05em; text-transform: uppercase; margin-bottom: 36px; }
  label { display: block; font-size: 11px; font-weight: 500; letter-spacing: 0.08em; text-transform: uppercase; color: var(--muted); margin-bottom: 6px; }
  input { width: 100%; padding: 11px 14px; border: 1px solid var(--cream2); background: white; border-radius: 2px; font-family: var(--sans); font-size: 15px; color: var(--ink); outline: none; transition: border-color 0.15s; margin-bottom: 20px; }
  input:focus { border-color: var(--amber); }
  .btn { width: 100%; padding: 13px; background: var(--amber); color: white; border: none; border-radius: 2px; font-family: var(--sans); font-size: 14px; font-weight: 500; letter-spacing: 0.04em; cursor: pointer; transition: background 0.15s; display: block; text-align: center; text-decoration: none; }
  .btn:hover { background: var(--amber2); }
  .error { background: #fef2f2; border: 1px solid #fecaca; color: #b91c1c; padding: 10px 14px; border-radius: 2px; font-size: 13px; margin-bottom: 20px; }
  .success { background: #f0fdf4; border: 1px solid #bbf7d0; color: #166534; padding: 10px 14px; border-radius: 2px; font-size: 13px; margin-bottom: 20px; }
  .powered { margin-top: 24px; font-size: 11px; color: var(--muted); text-align: center; letter-spacing: 0.04em; }
  .link { color: var(--amber); text-decoration: none; font-size: 13px; }
  .link:hover { text-decoration: underline; }
  .links { margin-top: 20px; text-align: center; }
  .help-text { font-size: 13px; color: var(--muted); line-height: 1.5; margin-bottom: 24px; }
  .code-input { font-size: 24px; letter-spacing: 0.3em; text-align: center; font-weight: 600; }
</style>
</head>
<body>
<div class="card">
  ${body}
  <div class="powered">A HoneXAI product</div>
</div>
</body>
</html>`;
}


function loginPage(error?: string): string {
  return authShell("Sign In", `
  <div class="wordmark">Connected<span>Carriers</span></div>
  <div class="subtitle">Broker Portal</div>
  ${error ? `<div class="error">${error}</div>` : ""}
  <form method="POST" action="/login">
    <label>Email</label>
    <input type="email" name="email" placeholder="you@company.com" required autofocus>
    <label>Password</label>
    <input type="password" name="password" placeholder="\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022" required>
    <button type="submit" class="btn">Sign in</button>
  </form>
  <div class="links">
    <a href="/forgot-password" class="link">Forgot password?</a>
  </div>
  `);
}


function forgotPasswordPage(error?: string): string {
  return authShell("Reset Password", `
  <div class="wordmark">Connected<span>Carriers</span></div>
  <div class="subtitle">Reset your password</div>
  ${error ? `<div class="error">${error}</div>` : ""}
  <p class="help-text">Enter the email address on your account. We'll text a verification code to the phone number we have on file.</p>
  <form method="POST" action="/forgot-password">
    <label>Email</label>
    <input type="email" name="email" placeholder="you@company.com" required autofocus>
    <button type="submit" class="btn">Send verification code</button>
  </form>
  <div class="links">
    <a href="/login" class="link">Back to sign in</a>
  </div>
  `);
}


function codeSentPage(email: string): string {
  return enterCodePage(email, "your phone on file");
}


function enterCodePage(email: string, maskedPhone: string, error?: string): string {
  const safeEmail = email.replace(/"/g, "&quot;");
  return authShell("Enter Code", `
  <div class="wordmark">Connected<span>Carriers</span></div>
  <div class="subtitle">Verify your identity</div>
  ${error ? `<div class="error">${error}</div>` : ""}
  <p class="help-text">We sent a 6-digit code to <strong>${maskedPhone || "your phone on file"}</strong>. Enter it below with your new password.</p>
  <form method="POST" action="/verify-code">
    <input type="hidden" name="email" value="${safeEmail}">
    <label>Verification code</label>
    <input type="text" name="code" required placeholder="000000" maxlength="6" inputmode="numeric" pattern="[0-9]{6}" class="code-input" autofocus>
    <label>New password</label>
    <input type="password" name="new_password" required placeholder="At least 8 characters" minlength="8">
    <label>Confirm password</label>
    <input type="password" name="confirm_password" required placeholder="\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022" minlength="8">
    <button type="submit" class="btn">Set password</button>
  </form>
  <div class="links">
    <a href="/forgot-password" class="link">Didn't get a code? Try again</a>
  </div>
  `);
}


function passwordSetSuccessPage(): string {
  return authShell("Password Updated", `
  <div class="wordmark">Connected<span>Carriers</span></div>
  <div class="subtitle">You're all set</div>
  <div class="success">Your password has been updated.</div>
  <a href="/login" class="btn">Sign in</a>
  `);
}
