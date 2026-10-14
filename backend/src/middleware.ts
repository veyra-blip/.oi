import { Request,Response,NextFunction } from "express"; import { verifyAccess } from "./auth.js";
export function requireAuth(req:any,res:Response,next:NextFunction){try{const h=req.headers.authorization||"";if(!h.startsWith("Bearer "))return res.status(401).json({success:false,message:"Authentication required."});req.userId=verifyAccess(h.slice(7)).sub;next()}catch{return res.status(401).json({success:false,message:"Invalid or expired session."})}}
export function asyncRoute(fn:any){return (req:Request,res:Response,next:NextFunction)=>Promise.resolve(fn(req,res,next)).catch(next)}
