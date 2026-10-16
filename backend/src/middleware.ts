import { Request, Response, NextFunction } from "express";
import { verifyAccess } from "./auth.js";
import { prisma } from "./db.js";

declare global {
  namespace Express {
    interface Request {
      userId?: string;
      userRole?: "USER" | "ADMIN";
    }
  }
}

export async function requireAuth(req: Request, res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) {
    return res.status(401).json({ success: false, code: "UNAUTHENTICATED", message: "Authentication required" });
  }
  try {
    const payload = verifyAccess(header.slice(7));
    const user = await prisma.user.findUnique({
      where: { id: payload.sub },
      select: { id: true, status: true, role: true }
    });
    if (!user) return res.status(401).json({ success: false, code: "INVALID_TOKEN", message: "Session expired" });
    if (user.status !== "ACTIVE") {
      return res.status(403).json({ success: false, code: "ACCOUNT_INACTIVE", message: "Account is not active." });
    }
    req.userId = user.id;
    req.userRole = user.role;
    return next();
  } catch {
    return res.status(401).json({ success: false, code: "INVALID_TOKEN", message: "Session expired" });
  }
}

export function requireAdmin(req: Request, res: Response, next: NextFunction) {
  if (req.userRole !== "ADMIN") {
    return res.status(403).json({ success: false, code: "ADMIN_ONLY", message: "Admin only." });
  }
  return next();
}

export function asyncRoute(fn: Function) {
  return (req: Request, res: Response, next: NextFunction) =>
    Promise.resolve(fn(req, res, next)).catch(next);
}
