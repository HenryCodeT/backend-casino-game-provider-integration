import { Request, Response, NextFunction } from "express";
import { verifySignature } from "../lib/hmac";
import { logger } from "../utils/logger";

export function verifyCasinoSignature(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  const secret = process.env.CASINO_SECRET;
  if (!secret) {
    logger.error("CASINO_SECRET not configured");
    res.status(500).json({ error: "Server misconfiguration" });
    return;
  }

  const signature = req.header("x-casino-signature");
  if (!verifySignature(signature, req.body, secret)) {
    logger.warn("Invalid casino signature", {
      path: req.path,
      ip: req.ip,
    });
    res.status(401).json({ error: "Invalid signature" });
    return;
  }

  next();
}
