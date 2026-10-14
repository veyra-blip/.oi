import { Request, Response, NextFunction } from "express";
import { verifyAccess } from "./auth.js";

declare global {
  namespace Express {
    interface Request {
      userId?: string;
    }
  }
}

export function requireAuth(req: Request, res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) {
    return res.status(401).json({ success: false, code: "UNAUTHENTICATED", message: "Authentication required" });
  }
  try {
    req.userId = verifyAccess(header.slice(7)).sub;
    next();
  } catch {
    return res.status(401).json({ success: false, code: "INVALID_TOKEN", message: "Session expired" });
  }
}

export function asyncRoute(fn: Function) {
  return (req: Request, res: Response, next: NextFunction) =>
    Promise.resolve(fn(req, res, next)).catch(next);
}
