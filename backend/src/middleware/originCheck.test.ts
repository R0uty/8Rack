import { afterEach, describe, expect, it, vi } from "vitest";
import type { Request, Response } from "express";
import { env } from "../config/env.js";
import { originCheck } from "./originCheck.js";

function run(method: string, origin?: string) {
  const res = { status: vi.fn(() => res), json: vi.fn(() => res) };
  const next = vi.fn();
  originCheck({ method, headers: { origin } } as unknown as Request, res as unknown as Response, next);
  return { res, next };
}

const originalAllowedHosts = env.allowedHosts;

afterEach(() => {
  env.allowedHosts = originalAllowedHosts;
});

describe("originCheck", () => {
  it("rejects a state-changing request from a foreign origin", () => {
    const { res, next } = run("POST", "https://evil.example");
    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });

  it("allows the configured frontend origin", () => {
    expect(run("POST", env.corsOrigin).next).toHaveBeenCalled();
  });

  it("allows the loopback spellings of a loopback frontend origin", () => {
    const { port, protocol, hostname } = new URL(env.corsOrigin);
    expect(hostname).toBe("localhost");
    expect(run("POST", `${protocol}//127.0.0.1:${port}`).next).toHaveBeenCalled();
  });

  it("doesn't treat another port on loopback as the frontend", () => {
    expect(run("POST", "http://localhost:9").res.status).toHaveBeenCalledWith(403);
  });

  it("leaves reads and non-browser clients alone", () => {
    expect(run("GET", "https://evil.example").next).toHaveBeenCalled();
    expect(run("OPTIONS", "https://evil.example").next).toHaveBeenCalled();
    expect(run("POST", undefined).next).toHaveBeenCalled();
  });

  it("is off when HOST is deliberately non-loopback, same as hostCheck", () => {
    env.allowedHosts = null;
    expect(run("POST", "https://evil.example").next).toHaveBeenCalled();
  });
});
