import crypto from "crypto";
import { Request, Response, NextFunction } from "express";
import { AuthenticatedRequest } from "./auth";

// ── HTML escaping ─────────────────────────────────────────────────
// Use this for every user-supplied value interpolated into HTML templates.
// Never trust DB values — they may contain carrier-submitted content.

const ESCAPE_MAP: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#x27;",
  "`": "&#x60;",
};

export function h(value: unknown): string {
  if (value === null || value === undefined) return "";
  return String(value).replace(/[&<>"'`]/g, (ch) => ESCAPE_MAP[ch] ?? ch);
}

// ── CSRF protection ───────────────────────────────────────────────
// Session-based double-submit pattern. No external dependencies.
// Token is generated per-session and embedded in every broker form.
// POST routes verify the submitted token matches the session token.

declare module "express-session" {
  interface SessionData {
    csrfToken?: string;
  }
}

export function csrfToken(req: Request): string {
  if (!req.session.csrfToken) {
    req.session.csrfToken = crypto.randomBytes(32).toString("hex");
  }
  return req.session.csrfToken;
}

// Hidden input to embed in every broker form
export function csrfField(req: Request): string {
  return `<input type="hidden" name="_csrf" value="${csrfToken(req)}">`;
}

// Middleware: validates _csrf on state-changing POST routes
// Apply to all broker POST routes (not public intake form)
export function verifyCsrf(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  if (req.method !== "POST") return next();
  const submitted = req.body?._csrf;
  const expected = req.session?.csrfToken;
  if (!submitted || !expected || submitted !== expected) {
    return res.status(403).send("Invalid or missing CSRF token. Please go back and try again.");
  }
  next();
}
