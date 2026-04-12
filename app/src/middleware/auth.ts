import { Request, Response, NextFunction } from "express";

export interface AuthenticatedRequest extends Request {
  session: Request["session"] & {
    userId?: number;
    brokerAccountId?: number;
    userRole?: string;
    userName?: string;
  };
}

export function requireAuth(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  if (!req.session?.userId) {
    return res.redirect("/login");
  }
  next();
}

export function requireOwner(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  if (!req.session?.userId) return res.redirect("/login");
  if (req.session.userRole !== "owner") {
    return res.status(403).send("Access denied");
  }
  next();
}
