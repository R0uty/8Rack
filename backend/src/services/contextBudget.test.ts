import { beforeEach, describe, expect, it } from "vitest";
import { calibrate, estimateTokens, fitToContext, resetCalibration } from "./contextBudget.js";
import type { ChatMessage } from "../types/ollama.js";

const big = (tool: string, n: number) => JSON.stringify({ tool, success: true, stdout: `${tool} output `.repeat(n) });

function transcript(results: number, size = 400): ChatMessage[] {
  const messages: ChatMessage[] = [{ role: "user", content: "Recon example.com" }];
  for (let i = 0; i < results; i++) {
    messages.push({ role: "assistant", content: `{"tool": "t${i}", "arguments": []}` });
    messages.push({ role: "tool", content: big(`t${i}`, size) });
  }
  return messages;
}

beforeEach(() => resetCalibration());

describe("fitToContext", () => {
  it("leaves a transcript that fits alone", () => {
    const messages = transcript(2, 10);
    const fit = fitToContext(messages, 1000, 16_000);
    expect(fit.elided).toBe(0);
    expect(fit.messages).toBe(messages);
  });

  it("shortens the oldest tool results first and keeps the objective, agent turns and newest results", () => {
    const messages = transcript(8);
    const fit = fitToContext(messages, 3000, 8000);
    expect(fit.elided).toBeGreaterThan(0);
    expect(fit.estimatedTokens).toBeLessThanOrEqual(8000);
    expect(fit.messages[0]).toEqual(messages[0]);
    expect(fit.messages.filter((m) => m.role === "assistant")).toEqual(messages.filter((m) => m.role === "assistant"));
    const tools = fit.messages.filter((m) => m.role === "tool");
    expect(JSON.parse(tools[0].content)).toMatchObject({ tool: "t0", elided: true, success: true });
    expect(tools.slice(-2).map((m) => m.content)).toEqual(messages.filter((m) => m.role === "tool").slice(-2).map((m) => m.content));
    // The stored transcript isn't touched.
    expect(messages[2].content).not.toContain("elided");
  });

  it("stops shortening once it fits", () => {
    const messages = transcript(8);
    const fit = fitToContext(messages, 0, estimateTokens(messages.reduce((n, m) => n + m.content.length, 0)) - 500);
    expect(fit.elided).toBe(1);
  });

  it("does what it can when even the newest results don't fit", () => {
    const fit = fitToContext(transcript(3, 4000), 0, 100);
    expect(fit.elided).toBe(1); // only the one result outside the newest two
    expect(fit.estimatedTokens).toBeGreaterThan(100);
  });
});

describe("calibrate", () => {
  it("moves the estimate toward what Ollama counted, within bounds", () => {
    const before = estimateTokens(3000);
    calibrate(3000, 750); // 4 chars/token
    expect(estimateTokens(3000)).toBeLessThan(before);
    for (let i = 0; i < 50; i++) calibrate(3000, 100); // 30 chars/token - not believable
    expect(estimateTokens(4000)).toBeGreaterThanOrEqual(1000);
  });
});
