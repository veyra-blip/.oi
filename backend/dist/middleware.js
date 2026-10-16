import { verifyAccess } from "./auth.js";
export function requireAuth(req, res, next) {
    const header = req.headers.authorization;
    if (!header?.startsWith("Bearer ")) {
        return res.status(401).json({ success: false, code: "UNAUTHENTICATED", message: "Authentication required" });
    }
    try {
        req.userId = verifyAccess(header.slice(7)).sub;
        next();
    }
    catch {
        return res.status(401).json({ success: false, code: "INVALID_TOKEN", message: "Session expired" });
    }
}
export function asyncRoute(fn) {
    return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}
