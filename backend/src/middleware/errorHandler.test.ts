import { describe, expect, it, vi } from "vitest";
import type { Request, Response } from "express";
import { errorHandler } from "./errorHandler.js";

function run(err: unknown) {
  const res = { status: vi.fn(() => res), json: vi.fn(() => res), headersSent: false };
  errorHandler(err as Error, {} as Request, res as unknown as Response, vi.fn());
  return res;
}

describe("errorHandler body-parser failures", () => {
  it("honors a body-parser 400 for malformed JSON", () => {
    const res = run(Object.assign(new SyntaxError("Unexpected token"), { status: 400, expose: true }));
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it("honors a body-parser 413 for an oversized body", () => {
    const res = run(Object.assign(new Error("request entity too large"), { status: 413, expose: true }));
    expect(res.status).toHaveBeenCalledWith(413);
  });

  it("keeps an unknown error at an opaque 500", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = run(new Error("secret internals"));
    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({ error: "Internal server error", code: "INTERNAL_ERROR" });
    spy.mockRestore();
  });
});
