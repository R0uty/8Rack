import { beforeEach, describe, expect, it, vi } from "vitest";
import { listModels } from "./ollama.js";
import { loadAgents } from "./agentManager.js";
import { listExecToolsWithStatus } from "./toolManager.js";
import { getSetupStatus } from "./setupCheck.js";
import type { AgentWithStatus } from "../types/agent.js";
import type { ExecToolWithStatus } from "../types/execTool.js";
import type { OllamaModel } from "../types/ollama.js";

vi.mock("./ollama.js", () => ({ listModels: vi.fn() }));
vi.mock("./agentManager.js", () => ({ loadAgents: vi.fn() }));
vi.mock("./toolManager.js", () => ({ listExecToolsWithStatus: vi.fn() }));

const agent = (id: string, model: string, enabled = true) => ({ id, name: id, model, enabled }) as AgentWithStatus;
const tool = (id: string, availability: "available" | "unavailable") =>
  ({ id, name: id, executable: id, enabled: true, availability }) as ExecToolWithStatus;

beforeEach(() => {
  vi.mocked(listModels).mockResolvedValue([{ name: "llama3:latest" }, { name: "nomic-embed-text:latest" }] as OllamaModel[]);
  vi.mocked(loadAgents).mockResolvedValue([agent("recon", "llama3"), agent("validator", "qwen2.5:14b"), agent("off", "gone", false)]);
  vi.mocked(listExecToolsWithStatus).mockReturnValue([
    tool("nmap", "available"),
    tool("definitely-not-installed-8rack", "unavailable"),
    tool("subfinder", "unavailable"),
  ]);
});

describe("getSetupStatus", () => {
  it("lists each enabled agent's model once, with the pull command when missing", async () => {
    const status = await getSetupStatus();
    expect(status.ollama.state).toBe("ok");
    const llama = status.models.find((m) => m.label === "llama3");
    expect(llama?.state).toBe("ok");
    const qwen = status.models.find((m) => m.label === "qwen2.5:14b");
    expect(qwen).toMatchObject({ state: "missing", fix: "ollama pull qwen2.5:14b" });
    expect(status.models.some((m) => m.label === "gone")).toBe(false);
    expect(status.ready).toBe(false);
  });

  it("names the install command for a missing recon tool and skips tools it has none for", async () => {
    const { tools } = await getSetupStatus();
    expect(tools.map((t) => t.label)).toEqual(["nmap", "subfinder"]);
    expect(tools[1]).toMatchObject({ state: "missing" });
    expect(tools[1].fix).toContain("subfinder");
  });

  it("reports Ollama missing and skips the model checks when it can't be reached", async () => {
    vi.mocked(listModels).mockRejectedValue(new Error("connect ECONNREFUSED"));
    const status = await getSetupStatus();
    expect(status.ollama).toMatchObject({ state: "missing", fix: "ollama serve" });
    expect(status.models).toEqual([]);
    expect(status.ready).toBe(false);
  });
});
