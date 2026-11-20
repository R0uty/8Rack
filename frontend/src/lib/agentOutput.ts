/** One piece of an agent's streamed reply: prose, or a tool call it asked for. */
export type OutputPart = { kind: "text"; text: string } | { kind: "tool"; tool: string; args: string[] };

/** A tool request in the Orchestrator's plain-text convention: {"tool": "...", "arguments": [...]},
 * optionally inside a ```json fence. Matches only a complete object, so a call still being streamed
 * stays as text until it closes. */
const TOOL_CALL = /(?:```(?:json)?\s*)?(\{\s*"tool"\s*:\s*"[^"]+"[\s\S]*?\})\s*(?:```)?/g;

function parseCall(json: string): { tool: string; args: string[] } | undefined {
  try {
    const parsed = JSON.parse(json) as { tool?: unknown; arguments?: unknown };
    if (typeof parsed.tool !== "string") return undefined;
    const args = Array.isArray(parsed.arguments) ? parsed.arguments.map(String) : [];
    return { tool: parsed.tool, args };
  } catch {
    return undefined;
  }
}

/** Splits an agent's raw output into prose and readable tool calls, instead of showing the JSON. */
export function splitAgentOutput(raw: string): OutputPart[] {
  const parts: OutputPart[] = [];
  let last = 0;
  for (const match of raw.matchAll(TOOL_CALL)) {
    const call = parseCall(match[1]);
    if (!call) continue;
    const before = raw.slice(last, match.index).trim();
    if (before) parts.push({ kind: "text", text: before });
    parts.push({ kind: "tool", ...call });
    last = (match.index ?? 0) + match[0].length;
  }
  const rest = raw.slice(last).trim();
  if (rest) parts.push({ kind: "text", text: rest });
  return parts;
}
