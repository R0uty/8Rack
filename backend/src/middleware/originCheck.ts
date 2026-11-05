import type { NextFunction, Request, Response } from "express";
import { env } from "../config/env.js";

const LOOPBACK_HOSTNAMES = ["localhost", "127.0.0.1", "[::1]"];

/** The configured frontend origin, plus its loopback spellings - the same dev server is reachable as
 * localhost:5173 and 127.0.0.1:5173. */
function allowedOrigins(corsOrigin: string): Set<string> {
  const origins = new Set([corsOrigin]);
  try {
    const url = new URL(corsOrigin);
    if (LOOPBACK_HOSTNAMES.includes(url.hostname)) {
      for (const hostname of LOOPBACK_HOSTNAMES) origins.add(`${url.protocol}//${hostname}${url.port ? `:${url.port}` : ""}`);
    }
  } catch {
    // Not a parseable origin - only an exact match can apply.
  }
  return origins;
}

const allowed = allowedOrigins(env.corsOrigin);

/**
 * Blocks cross-site request forgery. hostCheck.ts stops DNS rebinding, but a page on any site can still
 * aim a "simple" POST at http://localhost:3001 - CORS only stops it reading the response, not the
 * request running, and endpoints that take no body (reindex, agent reload, confirming an execution
 * whose id is known) don't even need the JSON preflight. Browsers always attach Origin to a cross-site
 * state-changing request, so its absence means a non-browser client, which this doesn't defend against.
 * Same opt-out as hostCheck: a non-loopback HOST has no known frontend origin to compare against.
 */
export function originCheck(req: Request, res: Response, next: NextFunction) {
  const origin = req.headers.origin;
  if (env.allowedHosts === null || !origin || req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS") {
    next();
    return;
  }
  if (allowed.has(origin)) {
    next();
    return;
  }
  res.status(403).json({
    error: `Requests from origin "${origin}" are not allowed. Set CORS_ORIGIN to the frontend's origin.`,
    code: "ORIGIN_NOT_ALLOWED",
  });
}
