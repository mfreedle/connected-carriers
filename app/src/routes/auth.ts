import { Router, Request, Response } from "express";
import bcrypt from "bcryptjs";
import { query } from "../db";
import { AuthenticatedRequest } from "../middleware/auth";

const router = Router();

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

export default router;

function loginPage(error?: string) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Connected Carriers — Sign In</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Playfair+Display:wght@400;600&family=DM+Sans:wght@300;400;500&display=swap" rel="stylesheet">
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  :root {
    --slate: #1C2B3A;
    --slate2: #243447;
    --amber: #C8892A;
    --amber2: #E09B35;
    --cream: #F7F5F0;
    --cream2: #EDE9E1;
    --ink: #141414;
    --muted: #6B7A8A;
    --serif: 'Playfair Display', Georgia, serif;
    --sans: 'DM Sans', system-ui, sans-serif;
  }
  body {
    font-family: var(--sans);
    background: var(--slate);
    min-height: 100vh;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 24px;
  }
  .card {
    background: var(--cream);
    border-radius: 4px;
    padding: 48px 44px;
    width: 100%;
    max-width: 420px;
  }
  .wordmark {
    font-family: var(--serif);
    font-size: 22px;
    color: var(--slate);
    margin-bottom: 8px;
  }
  .wordmark span { color: var(--amber); }
  .subtitle {
    font-size: 13px;
    color: var(--muted);
    letter-spacing: 0.05em;
    text-transform: uppercase;
    margin-bottom: 36px;
  }
  label {
    display: block;
    font-size: 11px;
    font-weight: 500;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--muted);
    margin-bottom: 6px;
  }
  input {
    width: 100%;
    padding: 11px 14px;
    border: 1px solid var(--cream2);
    background: white;
    border-radius: 2px;
    font-family: var(--sans);
    font-size: 15px;
    color: var(--ink);
    outline: none;
    transition: border-color 0.15s;
    margin-bottom: 20px;
  }
  input:focus { border-color: var(--amber); }
  .btn {
    width: 100%;
    padding: 13px;
    background: var(--amber);
    color: var(--slate);
    border: none;
    border-radius: 2px;
    font-family: var(--sans);
    font-size: 14px;
    font-weight: 500;
    letter-spacing: 0.04em;
    cursor: pointer;
    transition: background 0.15s;
  }
  .btn:hover { background: var(--amber2); }
  .error {
    background: #fef2f2;
    border: 1px solid #fecaca;
    color: #b91c1c;
    padding: 10px 14px;
    border-radius: 2px;
    font-size: 13px;
    margin-bottom: 20px;
  }
  .powered {
    margin-top: 24px;
    font-size: 11px;
    color: var(--muted);
    text-align: center;
    letter-spacing: 0.04em;
  }
</style>
</head>
<body>
<div class="card">
  <div class="wordmark">Connected<span>Carriers</span></div>
  <div class="subtitle">Broker Portal</div>
  ${error ? `<div class="error">${error}</div>` : ""}
  <form method="POST" action="/login">
    <label>Email</label>
    <input type="email" name="email" placeholder="you@company.com" required autofocus>
    <label>Password</label>
    <input type="password" name="password" placeholder="••••••••" required>
    <button type="submit" class="btn">Sign in</button>
  </form>
  <div class="powered">A HoneXAI product</div>
</div>
</body>
</html>`;
}
