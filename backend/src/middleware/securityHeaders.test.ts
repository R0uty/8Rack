import { describe, expect, it, vi } from "vitest";
import type { Request, Response } from "express";
import { securityHeaders } from "./securityHeaders.js";

function fakeRes() {
  const headers = new Map<string, string>();
  const res = {
    setHeader: vi.fn((name: string, value: string) => {
      headers.set(name.toLowerCase(), value);
    }),
  };
  return { res: res as unknown as Response, headers };
}

describe("securityHeaders", () => {
  it("sets nosniff, framing, and referrer protections on every response", () => {
    const { res, headers } = fakeRes();
    const next = vi.fn();
    const req = {} as Request;

    securityHeaders(req, res, next);

    expect(next).toHaveBeenCalledOnce();
    expect(headers.get("x-content-type-options")).toBe("nosniff");
    expect(headers.get("x-frame-options")).toBe("DENY");
    expect(headers.get("referrer-policy")).toBe("no-referrer");
    expect(headers.get("cross-origin-resource-policy")).toBe("same-origin");
    expect(headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
  });
});