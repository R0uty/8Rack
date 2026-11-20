import { describe, expect, it } from "vitest";
import { splitAgentOutput } from "./agentOutput";

describe("splitAgentOutput", () => {
  it("turns fenced and bare tool calls into readable parts, keeping the prose around them", () => {
    const raw = 'Scanning first.\n```json\n{"tool": "nmap", "arguments": ["-sV", "example.com"]}\n```\nThen {"tool": "httpx", "arguments": ["-u", "x"]}';
    expect(splitAgentOutput(raw)).toEqual([
      { kind: "text", text: "Scanning first." },
      { kind: "tool", tool: "nmap", args: ["-sV", "example.com"] },
      { kind: "text", text: "Then" },
      { kind: "tool", tool: "httpx", args: ["-u", "x"] },
    ]);
  });

  it("leaves a call that is still streaming, or isn't valid JSON, as text", () => {
    expect(splitAgentOutput('{"tool": "nmap", "argu')).toEqual([{ kind: "text", text: '{"tool": "nmap", "argu' }]);
  });
});
