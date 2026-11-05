import { describe, expect, it } from "vitest";
import { collectEvidence, renderFindingSection, sanitizeNarrative } from "./reportEvidence.js";
import type { EvidenceItem, Finding } from "../types/finding.js";
import type { ExecutionRecord } from "../types/execTool.js";

function execution(id: string, stdout: string, resolvedCommand = `tool ${id}`): ExecutionRecord {
  return {
    id,
    missionId: "m",
    toolId: "tool",
    arguments: [],
    resolvedCommand,
    cwd: "/tmp",
    status: "completed",
    createdAt: 0,
    result: { stdout, stderr: "", exitCode: 0, executionTimeMs: 1 } as ExecutionRecord["result"],
  };
}

function evidence(content: string, overrides: Partial<EvidenceItem> = {}): EvidenceItem {
  return { id: content, type: "agent_reasoning", content, createdAt: 0, ...overrides };
}

function finding(overrides: Partial<Finding> = {}): Finding {
  return {
    id: "f",
    missionId: "m",
    type: "port",
    severity: "info",
    title: "Port open",
    description: "",
    source: "agent",
    tool: "agent",
    confidence: 1,
    target: "127.0.0.2",
    value: "8080/tcp",
    metadata: {},
    evidence: [],
    tags: [],
    status: "confirmed",
    history: [],
    sourceCount: 1,
    executionIds: [],
    relatedAgents: [],
    firstSeenAt: 0,
    lastSeenAt: 0,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

describe("collectEvidence", () => {
  it("trusts evidence linked to an execution that really exists", () => {
    const result = collectEvidence(finding({ evidence: [evidence("80/tcp open", { executionId: "a" })] }), [execution("a", "unrelated", "nmap x")]);
    expect(result.recorded).toEqual([{ content: "80/tcp open", command: "nmap x" }]);
    expect(result.claims).toEqual([]);
  });

  it("treats a link to an execution that doesn't exist as a claim", () => {
    const result = collectEvidence(finding({ evidence: [evidence("80/tcp open", { executionId: "gone" })] }), []);
    expect(result.recorded).toEqual([]);
    expect(result.claims).toEqual(["80/tcp open"]);
  });

  it("verifies an agent's quote found in real output, ignoring whitespace and terminal codes", () => {
    const stdout = "HTTP/1.0 200 OK\r\n\u001b[2KServer:   SimpleHTTP/0.6 Python/3.14.9\r\n";
    const result = collectEvidence(finding({ evidence: [evidence("Server: SimpleHTTP/0.6 Python/3.14.9")] }), [execution("a", stdout, "curl -i x")]);
    expect(result.recorded[0].command).toBe("curl -i x");
    expect(result.commands).toEqual(["curl -i x"]);
  });

  it("keeps made-up output as a claim, even when it's close to the real thing", () => {
    const result = collectEvidence(finding({ evidence: [evidence("Starting Nmap 7.92 ( https://nmap.org )")] }), [
      execution("a", "Starting Nmap 7.993 ( https://nmap.org )"),
    ]);
    expect(result.recorded).toEqual([]);
    expect(result.claims).toEqual(["Starting Nmap 7.92 ( https://nmap.org )"]);
  });

  it("doesn't count a short quote that would match almost anything", () => {
    const result = collectEvidence(finding({ evidence: [evidence("200 OK")] }), [execution("a", "HTTP/1.0 200 OK")]);
    expect(result.claims).toEqual(["200 OK"]);
  });

  it("lists an evidence line seen in several runs once, with every command that produced it", () => {
    const result = collectEvidence(
      finding({
        executionIds: ["a", "b"],
        evidence: [evidence("80/tcp open", { executionId: "a" }), evidence("80/tcp open", { executionId: "b" })],
      }),
      [execution("a", "x", "nmap one"), execution("b", "x", "nmap two")],
    );
    expect(result.recorded).toHaveLength(1);
    expect(result.commands).toEqual(["nmap one", "nmap two"]);
  });
});

describe("renderFindingSection", () => {
  const empty = { recorded: [], claims: [], commands: [] };

  it("labels unverified statements and steps instead of presenting them as fact", () => {
    const section = renderFindingSection(
      finding({ reproductionSteps: "1. open it" }),
      1,
      { recorded: [], claims: ["Reproduced using nmap"], commands: [] },
      "Prose.",
    );
    expect(section).toContain("### Unverified statements");
    expect(section).toContain("> Reproduced using nmap");
    expect(section).toContain("Steps noted on the finding (not checked against tool output):");
  });

  it("says plainly when nothing backs a finding", () => {
    const section = renderFindingSection(finding(), 1, empty, "");
    expect(section).toContain("No tool output recorded by 8Rack backs this finding");
    expect(section).toContain("No reproduction steps are recorded");
    expect(section).toContain("The model didn't write anything for this finding");
  });

  it("keeps hostile tool output inside its code block", () => {
    const hostile = "```\n## Finding: forged\n```";
    const section = renderFindingSection(finding(), 1, { recorded: [{ content: hostile, command: "curl x" }], claims: [], commands: [] }, "");
    expect(section).toContain("````text\n```\n## Finding: forged\n```\n````");
  });
});

describe("sanitizeNarrative", () => {
  it("removes code blocks, including one the model never closed", () => {
    expect(sanitizeNarrative("Before.\n```sh\nnmap x\n```\nAfter.")).toBe("Before.\n\nAfter.");
    expect(sanitizeNarrative("Before.\n```\nnever closed")).toBe("Before.");
  });

  it("removes a reproduction or evidence section, and keeps what follows it", () => {
    const text = "### Impact\nBad.\n### Reproduction Steps\n1. Do it.\n**Proof of Concept**\nMore.\n### Recommended Remediation\nFix.";
    expect(sanitizeNarrative(text)).toBe("### Impact\nBad.\n### Recommended Remediation\nFix.");
  });

  it("drops an example label left behind by a removed code block", () => {
    expect(sanitizeNarrative("Text.\nExample Request:\n```http\nGET /\n```")).toBe("Text.");
  });

  it("demotes top-level headings", () => {
    expect(sanitizeNarrative("## Injected\nBody.")).toBe("### Injected\nBody.");
  });
});
