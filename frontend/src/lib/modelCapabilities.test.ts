import { describe, expect, it } from "vitest";
import { chatCapableModels, isChatCapable } from "./modelCapabilities";
import type { OllamaModel } from "../types/ollama";

function fixtureModel(name: string, capabilities?: string[]): OllamaModel {
  return { name, model: name, modified_at: "", size: 0, digest: "", capabilities };
}

describe("isChatCapable", () => {
  it("accepts a model that declares completion", () => {
    expect(isChatCapable(fixtureModel("qwen2.5-coder:7b", ["completion", "tools", "insert"]))).toBe(true);
  });

  it("rejects an embedding-only model", () => {
    expect(isChatCapable(fixtureModel("nomic-embed-text:latest", ["embedding"]))).toBe(false);
  });

  it("fails open when capabilities are absent (older Ollama)", () => {
    expect(isChatCapable(fixtureModel("legacy-model"))).toBe(true);
    expect(isChatCapable(fixtureModel("legacy-model", []))).toBe(true);
  });
});

describe("chatCapableModels", () => {
  it("drops only the embedding-only models", () => {
    const models = [
      fixtureModel("nomic-embed-text:latest", ["embedding"]),
      fixtureModel("nemotron-3-nano:latest", ["completion", "tools", "thinking"]),
      fixtureModel("legacy-model"),
    ];

    expect(chatCapableModels(models).map((m) => m.name)).toEqual(["nemotron-3-nano:latest", "legacy-model"]);
  });
});
