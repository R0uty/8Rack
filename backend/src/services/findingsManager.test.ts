import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildFindingsGraph,
  createAgentFinding,
  createFinding,
  deleteFinding,
  getDirectories,
  getPorts,
  getProjectFindings,
  getTechnologies,
  getVulnerabilities,
  ingestExecution,
  listFindings,
  loadFindingsFromDisk,
  lookupCvesByKeyword,
  lookupCvesForFinding,
  searchFindings,
  updateFinding,
} from "./findingsManager.js";
import { queryNvd } from "./cveLookup.js";
import { FindingNotFoundError } from "./errors.js";
import { listProjectIds, readProjectJson } from "./projectStore.js";
import type { ExecutionRecord } from "../types/execTool.js";
import type { Finding } from "../types/finding.js";

vi.mock("./cveLookup.js", () => ({ queryNvd: vi.fn() }));
const mockQueryNvd = vi.mocked(queryNvd);

vi.mock("./projectStore.js", () => ({
  listProjectIds: vi.fn(async () => []),
  readProjectJson: vi.fn(async () => []),
  writeProjectJson: vi.fn(async () => undefined),
}));
const mockListProjectIds = vi.mocked(listProjectIds);
const mockReadProjectJson = vi.mocked(readProjectJson);

function fixtureExecution(overrides: Partial<ExecutionRecord> = {}): ExecutionRecord {
  return {
    id: randomUUID(),
    projectId: "proj-1",
    toolId: "nmap",
    arguments: ["example.com"],
    resolvedCommand: "nmap example.com",
    cwd: "/tmp",
    status: "completed",
    createdAt: Date.now(),
    result: {
      stdout: "80/tcp open http",
      stderr: "",
      exitCode: 0,
      executionTimeMs: 5,
      success: true,
      timedOut: false,
      cancelled: false,
      truncated: false,
    },
    ...overrides,
  };
}

describe("ingestExecution", () => {
  it("parses a successful execution's stdout into findings", async () => {
    const projectId = randomUUID();
    const findings = await ingestExecution(fixtureExecution({ projectId }));
    expect(findings.length).toBeGreaterThan(0);
    expect(findings.some((f) => f.type === "port" && f.value === "80/tcp")).toBe(true);
    expect(findings[0].projectId).toBe(projectId);
  });

  it("returns [] for a failed execution", async () => {
    const findings = await ingestExecution(fixtureExecution({ result: undefined, status: "failed" }));
    expect(findings).toEqual([]);
  });

  it("returns [] for a tool with no registered parser", async () => {
    const findings = await ingestExecution(fixtureExecution({ toolId: "bash", arguments: ["-c", "echo hi"] }));
    expect(findings).toEqual([]);
  });

  it("deduplicates: re-ingesting the same execution increments sourceCount instead of duplicating", async () => {
    const projectId = randomUUID();
    const execution = fixtureExecution({ projectId });

    const first = await ingestExecution(execution);
    const second = await ingestExecution(execution);

    expect(first[0].id).toBe(second[0].id);
    expect(second[0].sourceCount).toBe(2);
    expect(listFindings(projectId, { type: "port" })).toHaveLength(1);
  });

  it("preserves a human-set status past 'potential' across re-detection", async () => {
    const projectId = randomUUID();
    const execution = fixtureExecution({ projectId });

    const [created] = await ingestExecution(execution);
    await updateFinding(created.id, { status: "confirmed" });

    const [reingested] = await ingestExecution(execution);
    expect(reingested.status).toBe("confirmed");
    expect(reingested.sourceCount).toBe(2);
  });

  it("links the triggering execution's id onto the finding, accumulating across re-detections", async () => {
    const projectId = randomUUID();
    const first = fixtureExecution({ projectId });
    const second = fixtureExecution({ projectId, id: randomUUID() });

    const [created] = await ingestExecution(first);
    expect(created.executionIds).toEqual([first.id]);

    const [reingested] = await ingestExecution(second);
    expect(reingested.executionIds).toEqual([first.id, second.id]);
  });
});

describe("CRUD", () => {
  it("createFinding performs a manual finding creation with source 'manual'", async () => {
    const projectId = randomUUID();
    const finding = await createFinding(projectId, {
      type: "credential",
      severity: "high",
      title: "Leaked API key",
      description: "Found in a JS bundle",
      target: "example.com",
      value: "api-key-1",
    });
    expect(finding.source).toBe("manual");
    expect(finding.tool).toBe("manual");
  });

  it("updateFinding throws FindingNotFoundError for an unknown id", async () => {
    await expect(updateFinding("nope", { status: "false_positive" })).rejects.toThrow(FindingNotFoundError);
  });

  it("updateFinding applies a patch and logs a history entry on status change", async () => {
    const projectId = randomUUID();
    const [created] = await ingestExecution(fixtureExecution({ projectId }));
    const updated = await updateFinding(created.id, { status: "false_positive", severity: "low" });
    expect(updated.status).toBe("false_positive");
    expect(updated.severity).toBe("low");
    expect(updated.history.at(-1)).toMatchObject({ status: "false_positive" });
  });

  it("updateFinding applies parameter/impact/reproductionSteps patches", async () => {
    const projectId = randomUUID();
    const [created] = await ingestExecution(fixtureExecution({ projectId }));
    const updated = await updateFinding(created.id, {
      parameter: "id",
      impact: "Full account takeover",
      reproductionSteps: "1. Send request X\n2. Observe Y",
    });
    expect(updated.parameter).toBe("id");
    expect(updated.impact).toBe("Full account takeover");
    expect(updated.reproductionSteps).toBe("1. Send request X\n2. Observe Y");
  });

  it("deleteFinding removes the finding, and throws for an unknown id", async () => {
    const projectId = randomUUID();
    const [created] = await ingestExecution(fixtureExecution({ projectId })); // [port, service]
    await deleteFinding(created.id);
    expect(listFindings(projectId).some((f) => f.id === created.id)).toBe(false);
    await expect(deleteFinding(created.id)).rejects.toThrow(FindingNotFoundError);
  });
});

describe("filters, search, and agent-facing helpers", () => {
  it("listFindings filters by type/severity/tool/target/tag", async () => {
    const projectId = randomUUID();
    await ingestExecution(fixtureExecution({ projectId }));
    await createFinding(projectId, {
      type: "technology",
      severity: "info",
      title: "nginx",
      description: "detected",
      target: "example.com",
      value: "nginx",
      tags: ["web"],
    });

    expect(listFindings(projectId, { type: "technology" })).toHaveLength(1);
    expect(listFindings(projectId, { tag: "web" })).toHaveLength(1);
    expect(listFindings(projectId, { type: "credential" })).toHaveLength(0);
  });

  it("searchFindings matches title/description/target/tool/value/tags case-insensitively", async () => {
    const projectId = randomUUID();
    await ingestExecution(fixtureExecution({ projectId })); // produces a port + a service finding
    expect(searchFindings(projectId, "PORT 80").length).toBeGreaterThanOrEqual(1);
    expect(searchFindings(projectId, "80/tcp:http")).toHaveLength(1); // service finding's value is unique
    expect(searchFindings(projectId, "nonexistent-thing")).toEqual([]);
  });

  it("agent-facing getters return the right slices", async () => {
    const projectId = randomUUID();
    await ingestExecution(fixtureExecution({ projectId }));
    await createFinding(projectId, {
      type: "potential_vulnerability",
      severity: "high",
      title: "Exposed panel",
      description: "d",
      target: "example.com",
      value: "exposed-panel",
    });
    await createFinding(projectId, {
      type: "directory",
      severity: "info",
      title: "/admin",
      description: "d",
      target: "example.com",
      value: "/admin",
    });
    await createFinding(projectId, {
      type: "technology",
      severity: "info",
      title: "nginx",
      description: "d",
      target: "example.com",
      value: "nginx",
    });

    expect(getPorts(projectId).every((f) => f.type === "port")).toBe(true);
    expect(getTechnologies(projectId).every((f) => f.type === "technology")).toBe(true);
    expect(getDirectories(projectId).every((f) => f.type === "directory")).toBe(true);
    expect(getVulnerabilities(projectId).every((f) => f.type === "potential_vulnerability")).toBe(true);
    expect(getProjectFindings(projectId).length).toBeGreaterThanOrEqual(4);
  });
});

describe("buildFindingsGraph", () => {
  it("produces target/tool/finding nodes and runs_on/discovered_by edges for a port finding", async () => {
    const projectId = randomUUID();
    await ingestExecution(fixtureExecution({ projectId }));

    const graph = buildFindingsGraph(projectId);
    expect(graph.nodes.some((n) => n.type === "target" && n.label === "example.com")).toBe(true);
    expect(graph.nodes.some((n) => n.type === "tool" && n.label === "nmap")).toBe(true);
    expect(graph.nodes.some((n) => n.type === "port")).toBe(true);
    expect(graph.edges.some((e) => e.relation === "runs_on")).toBe(true);
    expect(graph.edges.some((e) => e.relation === "discovered_by")).toBe(true);
  });

  it("links a service finding to its specific port node via 'uses' when the port matches", async () => {
    const projectId = randomUUID();
    await ingestExecution(fixtureExecution({ projectId, arguments: ["example.com"] }));

    const graph = buildFindingsGraph(projectId);
    const serviceNode = graph.nodes.find((n) => n.type === "service");
    const portNode = graph.nodes.find((n) => n.type === "port");
    expect(serviceNode).toBeDefined();
    expect(graph.edges.some((e) => e.source === portNode?.id && e.target === serviceNode?.id && e.relation === "uses")).toBe(
      true,
    );
  });

  it("links a cve finding back to its source finding via 'related_to' when sourceFindingId is set", async () => {
    const projectId = randomUUID();
    const tech = await createFinding(projectId, {
      type: "technology",
      severity: "info",
      title: "nginx",
      description: "d",
      target: "example.com",
      value: "nginx",
    });
    mockQueryNvd.mockResolvedValue([
      { id: "CVE-2021-1234", description: "d", cvssScore: 9.8, cvssSeverity: "critical", cvssVector: null, references: [] },
    ]);
    await lookupCvesForFinding(tech.id);

    const graph = buildFindingsGraph(projectId);
    const cveNode = graph.nodes.find((n) => n.type === "cve");
    expect(cveNode).toBeDefined();
    expect(graph.edges.some((e) => e.source === tech.id && e.target === cveNode?.id && e.relation === "related_to")).toBe(
      true,
    );
  });
});

describe("CVE lookup", () => {
  it("lookupCvesForFinding throws FindingNotFoundError for an unknown id", async () => {
    await expect(lookupCvesForFinding("nope")).rejects.toThrow(FindingNotFoundError);
  });

  it("lookupCvesForFinding creates cve findings sharing the source finding's target", async () => {
    const projectId = randomUUID();
    const tech = await createFinding(projectId, {
      type: "technology",
      severity: "info",
      title: "nginx",
      description: "d",
      target: "example.com",
      value: "nginx",
    });
    mockQueryNvd.mockResolvedValue([
      { id: "CVE-2021-1234", description: "d", cvssScore: 9.8, cvssSeverity: "critical", cvssVector: "V", references: ["u"] },
    ]);

    const results = await lookupCvesForFinding(tech.id);

    expect(mockQueryNvd).toHaveBeenCalledWith("nginx");
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ type: "cve", value: "CVE-2021-1234", target: "example.com", tool: "nvd" });
    expect(results[0].metadata.sourceFindingId).toBe(tech.id);
  });

  it("dedupes a repeat lookup of the same finding instead of duplicating cve findings", async () => {
    const projectId = randomUUID();
    const tech = await createFinding(projectId, {
      type: "technology",
      severity: "info",
      title: "nginx",
      description: "d",
      target: "example.com",
      value: "nginx",
    });
    mockQueryNvd.mockResolvedValue([
      { id: "CVE-2021-1234", description: "d", cvssScore: 9.8, cvssSeverity: "critical", cvssVector: null, references: [] },
    ]);

    const first = await lookupCvesForFinding(tech.id);
    const second = await lookupCvesForFinding(tech.id);

    expect(first[0].id).toBe(second[0].id);
    expect(second[0].sourceCount).toBe(2);
    expect(listFindings(projectId, { type: "cve" })).toHaveLength(1);
  });

  it("lookupCvesByKeyword creates cve findings without a sourceFindingId link", async () => {
    const projectId = randomUUID();
    mockQueryNvd.mockResolvedValue([
      { id: "CVE-2021-5678", description: "d", cvssScore: 4.0, cvssSeverity: "medium", cvssVector: null, references: [] },
    ]);

    const results = await lookupCvesByKeyword(projectId, "apache", "example.com");

    expect(results[0].metadata.sourceFindingId).toBeUndefined();
    expect(results[0]).toMatchObject({ type: "cve", target: "example.com" });
  });
});

describe("createAgentFinding", () => {
  it("creates a finding with source 'agent', stamping relatedAgents and tool with the creating agent", async () => {
    const projectId = randomUUID();
    const finding = await createAgentFinding(projectId, "recon-agent", {
      type: "potential_vulnerability",
      severity: "high",
      title: "Reflected XSS",
      description: "d",
      target: "example.com",
      value: "/search?q",
      parameter: "q",
      impact: "Session hijack",
      reproductionSteps: "1. Send crafted request\n2. Observe reflection",
      evidence: "raw HTTP exchange",
    });

    expect(finding.source).toBe("agent");
    expect(finding.tool).toBe("recon-agent");
    expect(finding.relatedAgents).toEqual(["recon-agent"]);
    expect(finding.parameter).toBe("q");
    expect(finding.impact).toBe("Session hijack");
    expect(finding.reproductionSteps).toBe("1. Send crafted request\n2. Observe reflection");
    expect(finding.evidence).toEqual([{ type: "agent_reasoning", content: "raw HTTP exchange", createdAt: expect.any(Number) }]);
  });

  it("accumulates relatedAgents across re-detection by a different agent", async () => {
    const projectId = randomUUID();
    const input = {
      type: "potential_vulnerability" as const,
      severity: "high" as const,
      title: "Reflected XSS",
      description: "d",
      target: "example.com",
      value: "/search?q",
    };
    await createAgentFinding(projectId, "recon-agent", input);
    const second = await createAgentFinding(projectId, "validator-agent", input);

    expect(second.relatedAgents).toEqual(["recon-agent", "validator-agent"]);
    expect(second.sourceCount).toBe(2);
  });
});

describe("evidence", () => {
  it("does not duplicate an evidence item whose content already exists", async () => {
    const projectId = randomUUID();
    const execution = fixtureExecution({ projectId });
    const [created] = await ingestExecution(execution);
    expect(created.evidence).toHaveLength(1);
    expect(created.evidence[0].type).toBe("tool_result");

    const [reingested] = await ingestExecution(execution); // identical stdout -> identical evidence text
    expect(reingested.evidence).toHaveLength(1);
  });

  it("caps the number of retained evidence items, dropping the oldest first", async () => {
    const projectId = randomUUID();
    const base = {
      type: "technology" as const,
      severity: "info" as const,
      title: "nginx",
      description: "d",
      target: "example.com",
      value: "nginx",
    };
    let finding = await createFinding(projectId, { ...base, evidence: "evidence-0" });
    for (let i = 1; i <= 25; i++) {
      finding = await createFinding(projectId, { ...base, evidence: `evidence-${i}` });
    }

    expect(finding.evidence.length).toBeLessThanOrEqual(20);
    expect(finding.evidence.at(-1)?.content).toBe("evidence-25");
    expect(finding.evidence.some((e) => e.content === "evidence-0")).toBe(false);
  });
});

describe("listFindings new filters", () => {
  it("filters by minConfidence", async () => {
    const projectId = randomUUID();
    const base = { type: "technology" as const, severity: "info" as const, description: "d", target: "example.com" };
    await createFinding(projectId, { ...base, title: "a", value: "a", confidence: 0.3 });
    await createFinding(projectId, { ...base, title: "b", value: "b", confidence: 0.9 });

    const result = listFindings(projectId, { minConfidence: 0.5 });
    expect(result).toHaveLength(1);
    expect(result[0].value).toBe("b");
  });

  it("filters by agent, matching either tool (agent-sourced) or relatedAgents", async () => {
    const projectId = randomUUID();
    await createAgentFinding(projectId, "recon-agent", {
      type: "potential_vulnerability",
      severity: "high",
      title: "a",
      description: "d",
      target: "example.com",
      value: "a",
    });
    await createFinding(projectId, {
      type: "technology",
      severity: "info",
      title: "b",
      description: "d",
      target: "example.com",
      value: "b",
    });

    const result = listFindings(projectId, { agent: "recon-agent" });
    expect(result).toHaveLength(1);
    expect(result[0].value).toBe("a");
  });
});

describe("status/evidence migration on load", () => {
  it("migrates old status vocabulary, backfills executionIds/relatedAgents, and wraps legacy string evidence", async () => {
    const projectId = randomUUID();
    const legacy = {
      id: "legacy-1",
      projectId,
      type: "port",
      severity: "info",
      title: "Port 80/tcp open",
      description: "",
      source: "scanner",
      tool: "nmap",
      confidence: 0.9,
      target: "example.com",
      value: "80/tcp",
      metadata: {},
      evidence: "raw evidence text",
      tags: [],
      status: "verified",
      history: [
        { status: "discovered", at: 0 },
        { status: "verified", at: 1 },
      ],
      sourceCount: 1,
      firstSeenAt: 0,
      lastSeenAt: 0,
      createdAt: 0,
      updatedAt: 0,
    } as unknown as Finding;

    mockListProjectIds.mockResolvedValueOnce([projectId]);
    mockReadProjectJson.mockResolvedValueOnce([legacy]);

    await loadFindingsFromDisk();

    const [migrated] = listFindings(projectId);
    expect(migrated.status).toBe("confirmed");
    expect(migrated.history.map((h) => h.status)).toEqual(["potential", "confirmed"]);
    expect(migrated.evidence).toEqual([{ type: "note", content: "raw evidence text", createdAt: 0 }]);
    expect(migrated.executionIds).toEqual([]);
    expect(migrated.relatedAgents).toEqual([]);
  });
});

beforeEach(() => {
  vi.clearAllMocks();
});
