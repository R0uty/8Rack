import { spawnSync } from "node:child_process";
import { env } from "../config/env.js";
import { listModels } from "./ollama.js";
import { loadAgents } from "./agentManager.js";
import { listExecToolsWithStatus } from "./toolManager.js";

export type SetupItemState = "ok" | "missing" | "warning";

export interface SetupItem {
  id: string;
  label: string;
  state: SetupItemState;
  detail?: string;
  /** A command that fixes it, when there is one. */
  fix?: string;
}

export interface SetupStatus {
  ollama: SetupItem;
  models: SetupItem[];
  tools: SetupItem[];
  /** True when nothing is missing - the dashboard hides the checklist then. */
  ready: boolean;
}

/** How to install each tool the factory leans on. Go tools assume `go` and `~/go/bin` on PATH, which
 * is where toolManager.ts also looks. */
const INSTALL: Record<string, string> = {
  nmap: "sudo apt install nmap   # or: sudo pacman -S nmap / brew install nmap",
  httpx: "go install -v github.com/projectdiscovery/httpx/cmd/httpx@latest",
  ffuf: "go install github.com/ffuf/ffuf/v2@latest",
  katana: "CGO_ENABLED=1 go install github.com/projectdiscovery/katana/cmd/katana@latest",
  nuclei: "go install -v github.com/projectdiscovery/nuclei/v3/cmd/nuclei@latest",
  subfinder: "go install -v github.com/projectdiscovery/subfinder/v2/cmd/subfinder@latest",
  amass: "go install -v github.com/owasp-amass/amass/v4/...@master",
  whois: "sudo apt install whois   # or: sudo pacman -S whois / brew install whois",
  dig: "sudo apt install dnsutils   # or: sudo pacman -S bind / brew install bind",
  nslookup: "sudo apt install dnsutils   # or: sudo pacman -S bind / brew install bind",
  grep: "sudo apt install ripgrep   # or: sudo pacman -S ripgrep / brew install ripgrep",
};

/** Ollama answers to "llama3" for an installed "llama3:latest". */
function hasModel(installed: Set<string>, model: string): boolean {
  return installed.has(model) || (!model.includes(":") && installed.has(`${model}:latest`));
}

function onPath(executable: string): boolean {
  return spawnSync("which", [executable], { encoding: "utf-8" }).status === 0;
}

/** Everything a first run needs, checked fresh. Before this, each gap only showed up later as a
 * failed work order. */
export async function getSetupStatus(): Promise<SetupStatus> {
  let installed: Set<string> | null = null;
  let ollama: SetupItem;
  try {
    installed = new Set((await listModels()).map((m) => m.name));
    ollama = { id: "ollama", label: "Ollama", state: "ok", detail: `Reachable at ${env.ollamaBaseUrl}` };
  } catch (err) {
    ollama = {
      id: "ollama",
      label: "Ollama",
      state: "missing",
      detail: `Not reachable at ${env.ollamaBaseUrl}: ${err instanceof Error ? err.message : String(err)}`,
      fix: "ollama serve",
    };
  }

  const models: SetupItem[] = [];
  if (installed) {
    const byModel = new Map<string, string[]>();
    for (const agent of await loadAgents()) {
      if (!agent.enabled) continue;
      byModel.set(agent.model, [...(byModel.get(agent.model) ?? []), agent.name]);
    }
    for (const [model, agentNames] of byModel) {
      const ok = hasModel(installed, model);
      models.push({
        id: `model:${model}`,
        label: model,
        state: ok ? "ok" : "missing",
        detail: `Used by ${agentNames.join(", ")}`,
        fix: ok ? undefined : `ollama pull ${model}`,
      });
    }
    // The embedding model only matters while the built-in index serves the knowledge base.
    if (!env.mcpRagServer) {
      const ok = hasModel(installed, env.embeddingModel);
      models.push({
        id: "embedding",
        label: env.embeddingModel,
        state: ok ? "ok" : "warning",
        detail: "Embedding model for the knowledge base",
        fix: ok ? undefined : `ollama pull ${env.embeddingModel}`,
      });
    }
  }

  const tools: SetupItem[] = listExecToolsWithStatus()
    .filter((tool) => tool.enabled && INSTALL[tool.id])
    .map((tool) => {
      if (tool.availability === "available") {
        return { id: `tool:${tool.id}`, label: tool.name, state: "ok", detail: tool.version ?? tool.resolvedPath };
      }
      // Something answers to the name but isn't the tool - the python `httpx` CLI is the usual one.
      const impostor = onPath(tool.executable);
      return {
        id: `tool:${tool.id}`,
        label: tool.name,
        state: "missing",
        detail: impostor
          ? `A different "${tool.executable}" is on PATH - install the real one and put it first.`
          : `"${tool.executable}" not found on PATH`,
        fix: INSTALL[tool.id],
      };
    });

  const ready = [ollama, ...models, ...tools].every((item) => item.state !== "missing");
  return { ollama, models, tools, ready };
}
