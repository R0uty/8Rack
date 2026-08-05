import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FakeFs } from "../test-utils/fakeFs.js";

// The factory uses a dynamic import (rather than a captured outer variable) specifically to dodge
// vi.mock's hoisting - it's moved above every top-level statement in this file, including regular
// imports, so a plain `import { createFakeFs } from ...` referenced by closure isn't reliably
// initialized yet when the factory first runs.
vi.mock("node:fs/promises", async () => {
  const { createFakeFs } = await import("../test-utils/fakeFs.js");
  return createFakeFs();
});
vi.mock("./ollama.js", () => ({ listModels: vi.fn() }));

import { getAgent, getAgentConfigWarnings, getEnabledAgents, reloadAgents } from "./agentManager.js";
import { listModels } from "./ollama.js";
import * as fakeFsModule from "node:fs/promises";
import type { Agent } from "../types/agent.js";
import type { OllamaModel } from "../types/ollama.js";

const fakeFs = fakeFsModule as unknown as FakeFs;
const mockListModels = vi.mocked(listModels);

// Mirrors agentManager.ts's own AGENTS_DIR resolution - this test file lives in the same
// directory, so the same relative path lands on the same real (but fake-fs-backed) location.
const AGENTS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../data/agents");

function seedAgent(filename: string, content: string) {
  fakeFs.files.set(`${AGENTS_DIR}/${filename}`, content);
}

const validAgent: Agent = {
  id: "planner",
  name: "Planner",
  description: "Breaks objectives into tasks.",
  model: "qwen2.5-coder:7b",
  systemPrompt: "You are the Planner.",
  temperature: 0.7,
  topP: 0.9,
  maxTokens: 0,
  icon: "🧭",
  color: "#fff",
  enabled: true,
};

beforeEach(() => {
  fakeFs.files.clear();
  mockListModels.mockReset();
});

describe("loading agent configs", () => {
  it("loads a valid agent config", async () => {
    seedAgent("planner.json", JSON.stringify(validAgent));
    mockListModels.mockResolvedValue([{ name: "qwen2.5-coder:7b" } as OllamaModel]);

    const agents = await reloadAgents();

    expect(agents).toHaveLength(1);
    expect(agents[0].id).toBe("planner");
  });

  it("sorts agents by name", async () => {
    seedAgent("z.json", JSON.stringify({ ...validAgent, id: "z-agent", name: "Zeta" }));
    seedAgent("a.json", JSON.stringify({ ...validAgent, id: "a-agent", name: "Alpha" }));
    mockListModels.mockResolvedValue([]);

    const agents = await reloadAgents();

    expect(agents.map((a) => a.name)).toEqual(["Alpha", "Zeta"]);
  });

  it("skips a file with invalid JSON", async () => {
    seedAgent("planner.json", JSON.stringify(validAgent));
    seedAgent("broken.json", "{ not valid json");
    mockListModels.mockResolvedValue([]);

    const agents = await reloadAgents();

    expect(agents).toHaveLength(1);
    expect(agents[0].id).toBe("planner");
  });

  it("skips a file missing required fields", async () => {
    seedAgent("planner.json", JSON.stringify(validAgent));
    seedAgent("incomplete.json", JSON.stringify({ id: "incomplete", name: "Incomplete" }));
    mockListModels.mockResolvedValue([]);

    const agents = await reloadAgents();

    expect(agents).toHaveLength(1);
    expect(agents[0].id).toBe("planner");
  });

  it("skips a file with a duplicate id", async () => {
    seedAgent("planner.json", JSON.stringify(validAgent));
    seedAgent("planner-2.json", JSON.stringify({ ...validAgent, name: "Planner Duplicate" }));
    mockListModels.mockResolvedValue([]);

    const agents = await reloadAgents();

    expect(agents).toHaveLength(1);
  });

  it("returns no warnings when every file is valid", async () => {
    seedAgent("planner.json", JSON.stringify(validAgent));
    mockListModels.mockResolvedValue([]);

    await reloadAgents();

    expect(getAgentConfigWarnings()).toEqual([]);
  });

  it("returns an empty list when the agents directory doesn't exist", async () => {
    mockListModels.mockResolvedValue([]);
    const agents = await reloadAgents();
    expect(agents).toEqual([]);
  });
});

describe("getAgentConfigWarnings", () => {
  it("reports a warning for invalid JSON, naming the file", async () => {
    seedAgent("broken.json", "{ not valid json");
    mockListModels.mockResolvedValue([]);

    await reloadAgents();

    expect(getAgentConfigWarnings()).toEqual([{ file: "broken.json", reason: "Invalid JSON" }]);
  });

  it("reports a warning for missing/malformed fields", async () => {
    seedAgent("incomplete.json", JSON.stringify({ id: "incomplete", name: "Incomplete" }));
    mockListModels.mockResolvedValue([]);

    await reloadAgents();

    expect(getAgentConfigWarnings()).toEqual([
      { file: "incomplete.json", reason: "Missing or malformed required fields" },
    ]);
  });

  it("reports a warning naming the duplicate id", async () => {
    seedAgent("planner.json", JSON.stringify(validAgent));
    seedAgent("planner-2.json", JSON.stringify({ ...validAgent, name: "Planner Duplicate" }));
    mockListModels.mockResolvedValue([]);

    await reloadAgents();

    expect(getAgentConfigWarnings()).toEqual([
      { file: "planner-2.json", reason: 'Duplicate agent id "planner"' },
    ]);
  });

  it("clears stale warnings on a subsequent reload once the file is fixed", async () => {
    seedAgent("broken.json", "{ not valid json");
    mockListModels.mockResolvedValue([]);
    await reloadAgents();
    expect(getAgentConfigWarnings()).toHaveLength(1);

    fakeFs.files.clear();
    seedAgent("broken.json", JSON.stringify(validAgent));
    await reloadAgents();

    expect(getAgentConfigWarnings()).toEqual([]);
  });
});

describe("online/offline status", () => {
  it("reports online when enabled and the model is available", async () => {
    seedAgent("planner.json", JSON.stringify(validAgent));
    mockListModels.mockResolvedValue([{ name: "qwen2.5-coder:7b" } as OllamaModel]);

    const [agent] = await reloadAgents();
    expect(agent.status).toBe("online");
  });

  it("reports offline when the model isn't installed", async () => {
    seedAgent("planner.json", JSON.stringify(validAgent));
    mockListModels.mockResolvedValue([{ name: "some-other-model" } as OllamaModel]);

    const [agent] = await reloadAgents();
    expect(agent.status).toBe("offline");
  });

  it("reports offline when disabled, even if the model is available", async () => {
    seedAgent("planner.json", JSON.stringify({ ...validAgent, enabled: false }));
    mockListModels.mockResolvedValue([{ name: "qwen2.5-coder:7b" } as OllamaModel]);

    const [agent] = await reloadAgents();
    expect(agent.status).toBe("offline");
  });

  it("reports every agent offline (never throws) when Ollama is unreachable", async () => {
    seedAgent("planner.json", JSON.stringify(validAgent));
    mockListModels.mockRejectedValue(new Error("connect ECONNREFUSED"));

    const agents = await reloadAgents();

    expect(agents[0].status).toBe("offline");
  });
});

describe("getAgent / getEnabledAgents", () => {
  it("finds an agent by id, undefined for unknown ids", async () => {
    seedAgent("planner.json", JSON.stringify(validAgent));
    mockListModels.mockResolvedValue([]);
    await reloadAgents();

    expect((await getAgent("planner"))?.id).toBe("planner");
    expect(await getAgent("nope")).toBeUndefined();
  });

  it("filters out disabled agents", async () => {
    seedAgent("planner.json", JSON.stringify(validAgent));
    seedAgent("disabled.json", JSON.stringify({ ...validAgent, id: "disabled-agent", enabled: false }));
    mockListModels.mockResolvedValue([]);
    await reloadAgents();

    const enabled = await getEnabledAgents();
    expect(enabled.map((a) => a.id)).toEqual(["planner"]);
  });
});
