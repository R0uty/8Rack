import type { NextFunction, Request, Response } from "express";

/**
 * Sets a small set of web security headers on every response. This backend serves JSON only (no
 * pages of its own - the frontend is a separate origin), so these are cheap defense-in-depth rather
 * than a document-policy: nosniff stops the browser from MIME-sniffing JSON responses into HTML,
 * frame/embedding protections block another origin from framing or no-cors-embedding the API, and
 * the strict CSP is harmless here (nothing owns a document) while reading as a clear policy if a
 * page is ever served from this app. Paired with hostCheck.ts as the other host-level mitigation.
 */
export function securityHeaders(_req: Request, res: Response, next: NextFunction) {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  res.setHeader("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'");
  next();
}