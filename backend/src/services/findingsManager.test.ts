import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildFindingsGraph,
  createFinding,
  deleteFinding,
  getDirectories,
  getPorts,
  getProjectFindings,
  getTechnologies,
  getVulnerabilities,
  ingestExecution,
  listFindings,
  lookupCvesByKeyword,
  lookupCvesForFinding,
  searchFindings,
  updateFinding,
} from "./findingsManager.js";
import { queryNvd } from "./cveLookup.js";
import { FindingNotFoundError } from "./errors.js";
import type { ExecutionRecord } from "../types/execTool.js";

vi.mock("./cveLookup.js", () => ({ queryNvd: vi.fn() }));
const mockQueryNvd = vi.mocked(queryNvd);

vi.mock("./projectStore.js", () => ({
  listProjectIds: vi.fn(async () => []),
  readProjectJson: vi.fn(async () => []),
  writeProjectJson: vi.fn(async () => undefined),
}));

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

  it("preserves a human-set verified/dismissed status across re-detection", async () => {
    const projectId = randomUUID();
    const execution = fixtureExecution({ projectId });

    const [created] = await ingestExecution(execution);
    await updateFinding(created.id, { status: "verified" });

    const [reingested] = await ingestExecution(execution);
    expect(reingested.status).toBe("verified");
    expect(reingested.sourceCount).toBe(2);
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
    await expect(updateFinding("nope", { status: "dismissed" })).rejects.toThrow(FindingNotFoundError);
  });

  it("updateFinding applies a patch and logs a history entry on status change", async () => {
    const projectId = randomUUID();
    const [created] = await ingestExecution(fixtureExecution({ projectId }));
    const updated = await updateFinding(created.id, { status: "dismissed", severity: "low" });
    expect(updated.status).toBe("dismissed");
    expect(updated.severity).toBe("low");
    expect(updated.history.at(-1)).toMatchObject({ status: "dismissed" });
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

beforeEach(() => {
  vi.clearAllMocks();
});
