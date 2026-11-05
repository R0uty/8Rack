import type { NextFunction, Request, Response } from "express";
import { env } from "../config/env.js";

/**
 * Blocks DNS rebinding: CORS only inspects the request's Origin header, so a page from an
 * attacker-controlled origin can point a short-TTL DNS record at 127.0.0.1 and make its own
 * fetch() same-origin to this server, bypassing CORS entirely. Checking the Host header itself
 * against an allowlist is the standard mitigation. See env.ts#allowedHosts for when this is
 * skipped (explicit LAN opt-in via HOST).
 */
export function hostCheck(req: Request, res: Response, next: NextFunction) {
  if (env.allowedHosts === null) {
    next();
    return;
  }
  const host = req.headers.host?.toLowerCase();
  if (host && env.allowedHosts.has(host)) {
    next();
    return;
  }
  res.status(403).json({
    error: `Request Host "${host ?? ""}" is not in the allowed list. Set ALLOWED_HOSTS to override.`,
    code: "HOST_NOT_ALLOWED",
  });
}
