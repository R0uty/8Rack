import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildFindingsGraph,
  createAgentFinding,
  createFinding,
  deleteFinding,
  getDirectories,
  getPorts,
  getMissionFindings,
  getTechnologies,
  getVulnerabilities,
  ingestExecution,
  listFindings,
  loadFindingsFromDisk,
  lookupCvesByKeyword,
  lookupCvesForFinding,
  searchFindings,
  updateFinding,
  validateFinding,
} from "./findingsManager.js";
import { queryNvd } from "./cveLookup.js";
import { FindingNotFoundError } from "./errors.js";
import { listMissionIds, readMissionJson } from "./missionStore.js";
import { listActivity } from "./activityLog.js";
import type { ExecutionRecord } from "../types/execTool.js";
import type { Finding } from "../types/finding.js";

vi.mock("./cveLookup.js", () => ({ queryNvd: vi.fn() }));
const mockQueryNvd = vi.mocked(queryNvd);

vi.mock("./missionStore.js", () => ({
  listMissionIds: vi.fn(async () => []),
  readMissionJson: vi.fn(async () => []),
  writeMissionJson: vi.fn(async () => undefined),
}));
const mockListMissionIds = vi.mocked(listMissionIds);
const mockReadMissionJson = vi.mocked(readMissionJson);

function fixtureExecution(overrides: Partial<ExecutionRecord> = {}): ExecutionRecord {
  return {
    id: randomUUID(),
    missionId: "proj-1",
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
    const missionId = randomUUID();
    const findings = await ingestExecution(fixtureExecution({ missionId }));
    expect(findings.length).toBeGreaterThan(0);
    expect(findings.some((f) => f.type === "port" && f.value === "80/tcp")).toBe(true);
    expect(findings[0].missionId).toBe(missionId);
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
    const missionId = randomUUID();
    const execution = fixtureExecution({ missionId });

    const first = await ingestExecution(execution);
    const second = await ingestExecution(execution);

    expect(first[0].id).toBe(second[0].id);
    expect(second[0].sourceCount).toBe(2);
    expect(listFindings(missionId, { type: "port" })).toHaveLength(1);
  });

  it("preserves a human-set status past 'potential' across re-detection", async () => {
    const missionId = randomUUID();
    const execution = fixtureExecution({ missionId });

    const [created] = await ingestExecution(execution);
    await updateFinding(created.id, { status: "confirmed" });

    const [reingested] = await ingestExecution(execution);
    expect(reingested.status).toBe("confirmed");
    expect(reingested.sourceCount).toBe(2);
  });

  it("links the triggering execution's id onto the finding, accumulating across re-detections", async () => {
    const missionId = randomUUID();
    const first = fixtureExecution({ missionId });
    const second = fixtureExecution({ missionId, id: randomUUID() });

    const [created] = await ingestExecution(first);
    expect(created.executionIds).toEqual([first.id]);

    const [reingested] = await ingestExecution(second);
    expect(reingested.executionIds).toEqual([first.id, second.id]);
  });
});

describe("CRUD", () => {
  it("createFinding performs a manual finding creation with source 'manual'", async () => {
    const missionId = randomUUID();
    const finding = await createFinding(missionId, {
      type: "credential",
      severity: "high",
      title: "Leaked API key",
      description: "Found in a JS bundle",
      target: "example.com",
      value: "api-key-1",
    });
    expect(finding.source).toBe("manual");
    expect(finding.tool).toBe("manual");

    const events = listActivity(missionId);
    expect(events.some((e) => e.type === "finding_created" && e.meta?.findingId === finding.id)).toBe(true);
  });

  it("updateFinding throws FindingNotFoundError for an unknown id", async () => {
    await expect(updateFinding("nope", { status: "false_positive" })).rejects.toThrow(FindingNotFoundError);
  });

  it("updateFinding applies a patch and logs a history entry on status change", async () => {
    const missionId = randomUUID();
    const [created] = await ingestExecution(fixtureExecution({ missionId }));
    const updated = await updateFinding(created.id, { status: "false_positive", severity: "low" });
    expect(updated.status).toBe("false_positive");
    expect(updated.severity).toBe("low");
    expect(updated.history.at(-1)).toMatchObject({ status: "false_positive" });

    const events = listActivity(missionId);
    expect(
      events.some(
        (e) => e.type === "finding_status_changed" && e.meta?.findingId === created.id && e.meta?.to === "false_positive",
      ),
    ).toBe(true);
  });

  it("validateFinding logs a finding_validated activity event, not a separate finding_status_changed", async () => {
    const missionId = randomUUID();
    const [created] = await ingestExecution(fixtureExecution({ missionId }));
    await validateFinding(created.id, "vulnerability-validator", "confirmed", "Reproduced against a test instance");

    const events = listActivity(missionId);
    expect(events.some((e) => e.type === "finding_validated" && e.meta?.findingId === created.id && e.meta?.verdict === "confirmed")).toBe(
      true,
    );
    expect(events.some((e) => e.type === "finding_status_changed")).toBe(false);
  });

  it("updateFinding applies parameter/impact/reproductionSteps patches", async () => {
    const missionId = randomUUID();
    const [created] = await ingestExecution(fixtureExecution({ missionId }));
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
    const missionId = randomUUID();
    const [created] = await ingestExecution(fixtureExecution({ missionId })); // [port, service]
    await deleteFinding(created.id);
    expect(listFindings(missionId).some((f) => f.id === created.id)).toBe(false);
    await expect(deleteFinding(created.id)).rejects.toThrow(FindingNotFoundError);
  });
});

describe("filters, search, and agent-facing helpers", () => {
  it("listFindings filters by type/severity/tool/target/tag", async () => {
    const missionId = randomUUID();
    await ingestExecution(fixtureExecution({ missionId }));
    await createFinding(missionId, {
      type: "technology",
      severity: "info",
      title: "nginx",
      description: "detected",
      target: "example.com",
      value: "nginx",
      tags: ["web"],
    });

    expect(listFindings(missionId, { type: "technology" })).toHaveLength(1);
    expect(listFindings(missionId, { tag: "web" })).toHaveLength(1);
    expect(listFindings(missionId, { type: "credential" })).toHaveLength(0);
  });

  it("searchFindings matches title/description/target/tool/value/tags case-insensitively", async () => {
    const missionId = randomUUID();
    await ingestExecution(fixtureExecution({ missionId })); // produces a port + a service finding
    expect(searchFindings(missionId, "PORT 80").length).toBeGreaterThanOrEqual(1);
    expect(searchFindings(missionId, "80/tcp:http")).toHaveLength(1); // service finding's value is unique
    expect(searchFindings(missionId, "nonexistent-thing")).toEqual([]);
  });

  it("agent-facing getters return the right slices", async () => {
    const missionId = randomUUID();
    await ingestExecution(fixtureExecution({ missionId }));
    await createFinding(missionId, {
      type: "potential_vulnerability",
      severity: "high",
      title: "Exposed panel",
      description: "d",
      target: "example.com",
      value: "exposed-panel",
    });
    await createFinding(missionId, {
      type: "directory",
      severity: "info",
      title: "/admin",
      description: "d",
      target: "example.com",
      value: "/admin",
    });
    await createFinding(missionId, {
      type: "technology",
      severity: "info",
      title: "nginx",
      description: "d",
      target: "example.com",
      value: "nginx",
    });

    expect(getPorts(missionId).every((f) => f.type === "port")).toBe(true);
    expect(getTechnologies(missionId).every((f) => f.type === "technology")).toBe(true);
    expect(getDirectories(missionId).every((f) => f.type === "directory")).toBe(true);
    expect(getVulnerabilities(missionId).every((f) => f.type === "potential_vulnerability")).toBe(true);
    expect(getMissionFindings(missionId).length).toBeGreaterThanOrEqual(4);
  });
});

describe("buildFindingsGraph", () => {
  it("produces target/tool/finding nodes and runs_on/discovered_by edges for a port finding", async () => {
    const missionId = randomUUID();
    await ingestExecution(fixtureExecution({ missionId }));

    const graph = buildFindingsGraph(missionId);
    expect(graph.nodes.some((n) => n.type === "target" && n.label === "example.com")).toBe(true);
    expect(graph.nodes.some((n) => n.type === "tool" && n.label === "nmap")).toBe(true);
    expect(graph.nodes.some((n) => n.type === "port")).toBe(true);
    expect(graph.edges.some((e) => e.relation === "runs_on")).toBe(true);
    expect(graph.edges.some((e) => e.relation === "discovered_by")).toBe(true);
  });

  it("links a service finding to its specific port node via 'uses' when the port matches", async () => {
    const missionId = randomUUID();
    await ingestExecution(fixtureExecution({ missionId, arguments: ["example.com"] }));

    const graph = buildFindingsGraph(missionId);
    const serviceNode = graph.nodes.find((n) => n.type === "service");
    const portNode = graph.nodes.find((n) => n.type === "port");
    expect(serviceNode).toBeDefined();
    expect(graph.edges.some((e) => e.source === portNode?.id && e.target === serviceNode?.id && e.relation === "uses")).toBe(
      true,
    );
  });

  it("links a cve finding back to its source finding via 'related_to' when sourceFindingId is set", async () => {
    const missionId = randomUUID();
    const tech = await createFinding(missionId, {
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

    const graph = buildFindingsGraph(missionId);
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
    const missionId = randomUUID();
    const tech = await createFinding(missionId, {
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
    const missionId = randomUUID();
    const tech = await createFinding(missionId, {
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
    expect(listFindings(missionId, { type: "cve" })).toHaveLength(1);
  });

  it("lookupCvesByKeyword creates cve findings without a sourceFindingId link", async () => {
    const missionId = randomUUID();
    mockQueryNvd.mockResolvedValue([
      { id: "CVE-2021-5678", description: "d", cvssScore: 4.0, cvssSeverity: "medium", cvssVector: null, references: [] },
    ]);

    const results = await lookupCvesByKeyword(missionId, "apache", "example.com");

    expect(results[0].metadata.sourceFindingId).toBeUndefined();
    expect(results[0]).toMatchObject({ type: "cve", target: "example.com" });
  });
});

describe("createAgentFinding", () => {
  it("creates a finding with source 'agent', stamping relatedAgents and tool with the creating agent", async () => {
    const missionId = randomUUID();
    const finding = await createAgentFinding(missionId, "recon-agent", {
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
    expect(finding.evidence).toEqual([
      {
        id: expect.any(String),
        type: "agent_reasoning",
        content: "raw HTTP exchange",
        createdAt: expect.any(Number),
        agentId: "recon-agent",
        executionId: undefined,
      },
    ]);
  });

  it("accumulates relatedAgents across re-detection by a different agent", async () => {
    const missionId = randomUUID();
    const input = {
      type: "potential_vulnerability" as const,
      severity: "high" as const,
      title: "Reflected XSS",
      description: "d",
      target: "example.com",
      value: "/search?q",
    };
    await createAgentFinding(missionId, "recon-agent", input);
    const second = await createAgentFinding(missionId, "validator-agent", input);

    expect(second.relatedAgents).toEqual(["recon-agent", "validator-agent"]);
    expect(second.sourceCount).toBe(2);
  });
});

describe("evidence", () => {
  it("does not duplicate an evidence item whose content already exists", async () => {
    const missionId = randomUUID();
    const execution = fixtureExecution({ missionId });
    const [created] = await ingestExecution(execution);
    expect(created.evidence).toHaveLength(1);
    expect(created.evidence[0].type).toBe("tool_result");

    const [reingested] = await ingestExecution(execution); // identical stdout -> identical evidence text
    expect(reingested.evidence).toHaveLength(1);
  });

  it("caps the number of retained evidence items, dropping the oldest first", async () => {
    const missionId = randomUUID();
    const base = {
      type: "technology" as const,
      severity: "info" as const,
      title: "nginx",
      description: "d",
      target: "example.com",
      value: "nginx",
    };
    let finding = await createFinding(missionId, { ...base, evidence: "evidence-0" });
    for (let i = 1; i <= 25; i++) {
      finding = await createFinding(missionId, { ...base, evidence: `evidence-${i}` });
    }

    expect(finding.evidence.length).toBeLessThanOrEqual(20);
    expect(finding.evidence.at(-1)?.content).toBe("evidence-25");
    expect(finding.evidence.some((e) => e.content === "evidence-0")).toBe(false);
  });
});

describe("listFindings new filters", () => {
  it("filters by minConfidence", async () => {
    const missionId = randomUUID();
    const base = { type: "technology" as const, severity: "info" as const, description: "d", target: "example.com" };
    await createFinding(missionId, { ...base, title: "a", value: "a", confidence: 0.3 });
    await createFinding(missionId, { ...base, title: "b", value: "b", confidence: 0.9 });

    const result = listFindings(missionId, { minConfidence: 0.5 });
    expect(result).toHaveLength(1);
    expect(result[0].value).toBe("b");
  });

  it("filters by agent, matching either tool (agent-sourced) or relatedAgents", async () => {
    const missionId = randomUUID();
    await createAgentFinding(missionId, "recon-agent", {
      type: "potential_vulnerability",
      severity: "high",
      title: "a",
      description: "d",
      target: "example.com",
      value: "a",
    });
    await createFinding(missionId, {
      type: "technology",
      severity: "info",
      title: "b",
      description: "d",
      target: "example.com",
      value: "b",
    });

    const result = listFindings(missionId, { agent: "recon-agent" });
    expect(result).toHaveLength(1);
    expect(result[0].value).toBe("a");
  });
});

describe("status/evidence migration on load", () => {
  it("migrates old status vocabulary, backfills executionIds/relatedAgents, and wraps legacy string evidence", async () => {
    const missionId = randomUUID();
    const legacy = {
      id: "legacy-1",
      missionId,
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

    mockListMissionIds.mockResolvedValueOnce([missionId]);
    mockReadMissionJson.mockResolvedValueOnce([legacy]);

    await loadFindingsFromDisk();

    const [migrated] = listFindings(missionId);
    expect(migrated.status).toBe("confirmed");
    expect(migrated.history.map((h) => h.status)).toEqual(["potential", "confirmed"]);
    expect(migrated.evidence).toEqual([{ id: expect.any(String), type: "note", content: "raw evidence text", createdAt: 0 }]);
    expect(migrated.executionIds).toEqual([]);
    expect(migrated.relatedAgents).toEqual([]);
  });
});

beforeEach(() => {
  vi.clearAllMocks();
});
