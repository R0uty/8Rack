import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { listModels } from "./ollama.js";
import type { Agent, AgentConfigWarning, AgentWithStatus } from "../types/agent.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const AGENTS_DIR = path.resolve(__dirname, "../../data/agents");

function isValidAgent(value: unknown): value is Agent {
  const v = value as Partial<Agent> | null;
  return (
    !!v &&
    typeof v.id === "string" &&
    v.id.trim().length > 0 &&
    typeof v.name === "string" &&
    typeof v.description === "string" &&
    typeof v.model === "string" &&
    typeof v.systemPrompt === "string" &&
    typeof v.temperature === "number" &&
    typeof v.topP === "number" &&
    typeof v.maxTokens === "number" &&
    typeof v.icon === "string" &&
    typeof v.color === "string" &&
    typeof v.enabled === "boolean" &&
    (v.tools === undefined || (Array.isArray(v.tools) && v.tools.every((t) => typeof t === "string")))
  );
}

/** Reads and validates every agent config file from disk. Malformed files are skipped with a warning
 * rather than failing the whole load — one bad file shouldn't take down every other agent. Returns
 * both the valid agents and a record of every file that got skipped and why, so callers (the API,
 * ultimately the UI) can surface load problems instead of only a server-side console.warn. */
async function readAgentConfigs(): Promise<{ agents: Agent[]; warnings: AgentConfigWarning[] }> {
  const warnings: AgentConfigWarning[] = [];

  let entries: string[];
  try {
    entries = await readdir(AGENTS_DIR);
  } catch {
    return { agents: [], warnings };
  }

  const agents: Agent[] = [];
  const seenIds = new Set<string>();

  for (const entry of entries.filter((f) => f.endsWith(".json"))) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(path.join(AGENTS_DIR, entry), "utf-8"));
    } catch {
      const reason = "Invalid JSON";
      console.warn(`Skipping invalid agent file (bad JSON): ${entry}`);
      warnings.push({ file: entry, reason });
      continue;
    }
    if (!isValidAgent(parsed)) {
      const reason = "Missing or malformed required fields";
      console.warn(`Skipping invalid agent file (missing/malformed fields): ${entry}`);
      warnings.push({ file: entry, reason });
      continue;
    }
    if (seenIds.has(parsed.id)) {
      const reason = `Duplicate agent id "${parsed.id}"`;
      console.warn(`Skipping agent file with duplicate id "${parsed.id}": ${entry}`);
      warnings.push({ file: entry, reason });
      continue;
    }
    seenIds.add(parsed.id);
    agents.push(parsed);
  }

  return { agents: agents.sort((a, b) => a.name.localeCompare(b.name)), warnings };
}

/**
 * Checks each agent's configured model against what's actually installed in Ollama. Never throws —
 * if Ollama itself is unreachable, every agent is simply reported offline instead of erroring, per
 * the "display unavailable agents as offline" requirement.
 */
async function withStatus(agents: Agent[]): Promise<AgentWithStatus[]> {
  let availableModels: Set<string> | null;
  try {
    availableModels = new Set((await listModels()).map((m) => m.name));
  } catch {
    availableModels = null;
  }

  return agents.map((agent) => ({
    ...agent,
    status: agent.enabled && availableModels?.has(agent.model) ? "online" : "offline",
  }));
}

let cache: AgentWithStatus[] | null = null;
let warningsCache: AgentConfigWarning[] = [];

/** Returns the agent list, loading it from disk (and validating against Ollama) on first call only. */
export async function loadAgents(): Promise<AgentWithStatus[]> {
  if (cache) return cache;
  return reloadAgents();
}

/** Forces a fresh read from disk and re-validates every agent's model against Ollama. */
export async function reloadAgents(): Promise<AgentWithStatus[]> {
  const { agents, warnings } = await readAgentConfigs();
  cache = await withStatus(agents);
  warningsCache = warnings;
  return cache;
}

/** Config-file problems (bad JSON, missing fields, duplicate ids) from the most recent load/reload —
 * populated as a side effect of loadAgents()/reloadAgents(), so call one of those first. */
export function getAgentConfigWarnings(): AgentConfigWarning[] {
  return warningsCache;
}

export async function getAgent(id: string): Promise<AgentWithStatus | undefined> {
  return (await loadAgents()).find((a) => a.id === id);
}

/** Agents the admin has turned on (config `enabled: true`) — may still be offline if the model is missing. */
export async function getEnabledAgents(): Promise<AgentWithStatus[]> {
  return (await loadAgents()).filter((a) => a.enabled);
}
