import { Request, Response, NextFunction } from "express";
import { verifySignature } from "../lib/hmac";

export function verifyProviderSignature(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  const secret = process.env.PROVIDER_SECRET;
  if (!secret) {
    console.error("PROVIDER_SECRET not configured");
    res.status(500).json({ error: "Server misconfiguration" });
    return;
  }

  const signature = req.header("x-provider-signature");
  if (!verifySignature(signature, req.body, secret)) {
    console.warn("Invalid provider signature", {
      path: req.path,
      ip: req.ip,
    });
    res.status(401).json({ error: "Invalid signature" });
    return;
  }

  next();
}
