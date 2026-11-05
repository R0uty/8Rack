import { describe, expect, it } from "vitest";
import { isValidMessages, isValidToolNames, sanitizeChatOptions } from "./chatValidation.js";

describe("isValidMessages", () => {
  it("accepts a non-empty array of well-formed messages", () => {
    expect(isValidMessages([{ role: "user", content: "hi" }])).toBe(true);
  });

  it("rejects an empty array", () => {
    expect(isValidMessages([])).toBe(false);
  });

  it("rejects a message with an invalid role", () => {
    expect(isValidMessages([{ role: "tool", content: "hi" }])).toBe(false);
  });
});

describe("isValidToolNames", () => {
  it("accepts an array of strings", () => {
    expect(isValidToolNames(["bash", "nmap"])).toBe(true);
  });

  it("rejects a non-array", () => {
    expect(isValidToolNames("bash")).toBe(false);
  });
});

describe("sanitizeChatOptions", () => {
  it("returns undefined for a non-object", () => {
    expect(sanitizeChatOptions("not an object")).toBeUndefined();
    expect(sanitizeChatOptions(null)).toBeUndefined();
    expect(sanitizeChatOptions(undefined)).toBeUndefined();
  });

  it("returns undefined for an object with no known fields", () => {
    expect(sanitizeChatOptions({ foo: "bar" })).toBeUndefined();
  });

  it("passes through in-range values unchanged", () => {
    expect(sanitizeChatOptions({ temperature: 0.7, top_p: 0.9, num_predict: 512, num_ctx: 4096 })).toEqual({
      temperature: 0.7,
      top_p: 0.9,
      num_predict: 512,
      num_ctx: 4096,
    });
  });

  it("clamps an absurdly large num_ctx instead of forwarding it to Ollama unbounded", () => {
    expect(sanitizeChatOptions({ num_ctx: 999_999_999 })).toEqual({ num_ctx: 131_072 });
  });

  it("clamps an absurdly large num_predict", () => {
    expect(sanitizeChatOptions({ num_predict: 999_999_999 })).toEqual({ num_predict: 131_072 });
  });

  it("clamps out-of-range temperature and top_p", () => {
    expect(sanitizeChatOptions({ temperature: 999, top_p: -5 })).toEqual({ temperature: 2, top_p: 0 });
  });

  it("preserves Ollama's -1 and -2 num_predict sentinels instead of clamping them to 0", () => {
    expect(sanitizeChatOptions({ num_predict: -1 })).toEqual({ num_predict: -1 });
    expect(sanitizeChatOptions({ num_predict: -2 })).toEqual({ num_predict: -2 });
  });

  it("clamps a negative num_predict that isn't a recognized sentinel", () => {
    expect(sanitizeChatOptions({ num_predict: -100 })).toEqual({ num_predict: 0 });
  });

  it("drops non-numeric or non-finite fields instead of forwarding garbage", () => {
    expect(sanitizeChatOptions({ temperature: "hot", num_ctx: Number.NaN, top_p: Number.POSITIVE_INFINITY })).toBeUndefined();
  });

  it("silently drops unknown keys rather than forwarding them", () => {
    expect(sanitizeChatOptions({ temperature: 0.5, mirostat: 2, num_gpu: 999 })).toEqual({ temperature: 0.5 });
  });
});
