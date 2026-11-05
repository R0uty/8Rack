import { afterEach, describe, expect, it, vi } from "vitest";
import type { Request, Response } from "express";
import { env } from "../config/env.js";
import { hostCheck } from "./hostCheck.js";

function fakeRes() {
  const res = {
    status: vi.fn(() => res),
    json: vi.fn(() => res),
  };
  return res as unknown as Response;
}

function fakeReq(host?: string) {
  return { headers: { host } } as unknown as Request;
}

const originalAllowedHosts = env.allowedHosts;

afterEach(() => {
  env.allowedHosts = originalAllowedHosts;
});

describe("hostCheck", () => {
  it("calls next() when the Host header is in the allowlist", () => {
    env.allowedHosts = new Set(["localhost:3001", "127.0.0.1:3001"]);
    const next = vi.fn();
    hostCheck(fakeReq("127.0.0.1:3001"), fakeRes(), next);
    expect(next).toHaveBeenCalledOnce();
  });

  it("matches case-insensitively", () => {
    env.allowedHosts = new Set(["localhost:3001"]);
    const next = vi.fn();
    hostCheck(fakeReq("LOCALHOST:3001"), fakeRes(), next);
    expect(next).toHaveBeenCalledOnce();
  });

  it("rejects a Host header not in the allowlist with 403", () => {
    env.allowedHosts = new Set(["localhost:3001", "127.0.0.1:3001"]);
    const res = fakeRes();
    const next = vi.fn();
    hostCheck(fakeReq("evil.com"), res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ code: "HOST_NOT_ALLOWED" }),
    );
  });

  it("rejects a missing Host header", () => {
    env.allowedHosts = new Set(["localhost:3001"]);
    const res = fakeRes();
    const next = vi.fn();
    hostCheck(fakeReq(undefined), res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it("skips enforcement entirely when allowedHosts is null", () => {
    env.allowedHosts = null;
    const next = vi.fn();
    hostCheck(fakeReq("anything.example"), fakeRes(), next);
    expect(next).toHaveBeenCalledOnce();
  });
});
