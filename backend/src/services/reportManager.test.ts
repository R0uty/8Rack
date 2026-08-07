import { beforeEach, describe, expect, it, vi } from "vitest";
import { getAgent } from "./agentManager.js";
import { streamAgentChat } from "./chatService.js";
import { getFinding } from "./findingsManager.js";
import { createReport, deleteReport, getReport, listReports, splitSections } from "./reportManager.js";
import { FindingNotFoundError, NoFindingsSelectedError, ReportNotFoundError } from "./errors.js";
import type { AgentWithStatus } from "../types/agent.js";
import type { ChatResponseChunk } from "../types/ollama.js";
import type { Finding } from "../types/finding.js";

vi.mock("./projectStore.js", () => ({
  listProjectIds: vi.fn(async () => []),
  readProjectJson: vi.fn(async () => []),
  writeProjectJson: vi.fn(async () => undefined),
}));
vi.mock("./agentManager.js", () => ({ getAgent: vi.fn() }));
vi.mock("./chatService.js", () => ({ streamAgentChat: vi.fn() }));
vi.mock("./findingsManager.js", () => ({ getFinding: vi.fn() }));

const mockGetAgent = vi.mocked(getAgent);
const mockStreamAgentChat = vi.mocked(streamAgentChat);
const mockGetFinding = vi.mocked(getFinding);

const fixtureAgent: AgentWithStatus = {
  id: "report-writer",
  name: "Report Writer",
  description: "",
  model: "test-model",
  systemPrompt: "Write reports.",
  temperature: 0.4,
  topP: 0.9,
  maxTokens: 2048,
  icon: "",
  color: "",
  enabled: true,
  status: "online",
};

function fixtureFinding(overrides: Partial<Finding> = {}): Finding {
  return {
    id: "finding-1",
    projectId: "proj-1",
    type: "potential_vulnerability",
    severity: "high",
    title: "SQL Injection in /login",
    description: "The login form is vulnerable to SQL injection.",
    source: "agent",
    tool: "manual",
    confidence: 0.8,
    target: "example.com",
    value: "sqli-login",
    metadata: {},
    evidence: "' OR 1=1 --",
    tags: [],
    status: "discovered",
    history: [],
    sourceCount: 1,
    firstSeenAt: 0,
    lastSeenAt: 0,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  };
}

/** Yields the given text as a single assistant chunk, matching real streamAgentChat's shape. */
function replyGenerator(content: string) {
  return async function* (): AsyncGenerator<ChatResponseChunk> {
    yield { model: "test-model", created_at: "", message: { role: "assistant", content }, done: true };
  };
}

beforeEach(() => {
  mockGetAgent.mockResolvedValue(fixtureAgent);
});

describe("createReport", () => {
  it("throws without any findings selected", async () => {
    await expect(createReport("proj-1", "Report", [])).rejects.toThrow(NoFindingsSelectedError);
    expect(mockStreamAgentChat).not.toHaveBeenCalled();
  });

  it("throws for a finding id that doesn't resolve, without calling the agent", async () => {
    mockGetFinding.mockReturnValue(undefined);
    await expect(createReport("proj-1", "Report", ["nope"])).rejects.toThrow(FindingNotFoundError);
    expect(mockStreamAgentChat).not.toHaveBeenCalled();
  });

  it("generates and persists a report, streaming chunks as they arrive", async () => {
    mockGetFinding.mockReturnValue(fixtureFinding());
    mockStreamAgentChat.mockImplementation(replyGenerator("## Executive Summary\nLooks bad.\n## Finding: SQLi\nFix it."));

    const chunks: string[] = [];
    const report = await createReport("proj-1", "My Report", ["finding-1"], (c) => chunks.push(c));

    expect(chunks.join("")).toContain("Executive Summary");
    expect(report.projectId).toBe("proj-1");
    expect(report.title).toBe("My Report");
    expect(report.findingIds).toEqual(["finding-1"]);
    expect(report.agentId).toBe("report-writer");
    expect(report.model).toBe("test-model");
    expect(report.markdown).toContain("Executive Summary");
    expect(report.sections).toHaveLength(2);
    expect(report.sections[0]).toEqual({ heading: "Executive Summary", content: "Looks bad." });
    expect(report.sections[1]).toEqual({ heading: "Finding: SQLi", content: "Fix it." });
  });

  it("passes the findings' data into the agent prompt", async () => {
    mockGetFinding.mockReturnValue(fixtureFinding({ title: "SQL Injection in /login", target: "example.com" }));
    mockStreamAgentChat.mockImplementation(replyGenerator("report body"));

    await createReport("proj-1", "My Report", ["finding-1"]);

    const [request] = mockStreamAgentChat.mock.calls.at(-1)!;
    expect(request.agentId).toBe("report-writer");
    expect(request.messages[0].content).toContain("SQL Injection in /login");
    expect(request.messages[0].content).toContain("example.com");
    expect(request.messages[0].content).toContain("My Report");
  });

  it("supports an agentId/model override", async () => {
    mockGetFinding.mockReturnValue(fixtureFinding());
    mockStreamAgentChat.mockImplementation(replyGenerator("report body"));

    const report = await createReport(
      "proj-1",
      "My Report",
      ["finding-1"],
      undefined,
      undefined,
      "general-assistant",
      "override-model",
    );

    expect(report.agentId).toBe("general-assistant");
    expect(report.model).toBe("override-model");
    const [request] = mockStreamAgentChat.mock.calls.at(-1)!;
    expect(request.agentId).toBe("general-assistant");
    expect(request.model).toBe("override-model");
  });
});

describe("splitSections", () => {
  it("splits on H2 headings", () => {
    const sections = splitSections("## One\nfirst\n## Two\nsecond\nmore");
    expect(sections).toEqual([
      { heading: "One", content: "first" },
      { heading: "Two", content: "second\nmore" },
    ]);
  });

  it("falls back to a single whole-document section when there are no H2 headings", () => {
    expect(splitSections("just prose, no headings")).toEqual([
      { heading: "Report", content: "just prose, no headings" },
    ]);
  });

  it("returns no sections for empty/whitespace-only markdown", () => {
    expect(splitSections("   \n  ")).toEqual([]);
  });
});

describe("listReports / getReport / deleteReport", () => {
  it("only returns reports for the requested project, and getReport finds by id across projects", async () => {
    mockGetFinding.mockReturnValue(fixtureFinding());
    mockStreamAgentChat.mockImplementation(replyGenerator("body"));

    await createReport("proj-list-a", "Report A1", ["finding-1"]);
    await createReport("proj-list-a", "Report A2", ["finding-1"]);
    const reportB = await createReport("proj-list-b", "Report B1", ["finding-1"]);

    expect(listReports("proj-list-a")).toHaveLength(2);
    expect(listReports("proj-list-b")).toHaveLength(1);
    expect(getReport(reportB.id)?.projectId).toBe("proj-list-b");
    expect(getReport("nope")).toBeUndefined();
  });

  it("deletes a report and refuses to delete an unknown id", async () => {
    mockGetFinding.mockReturnValue(fixtureFinding());
    mockStreamAgentChat.mockImplementation(replyGenerator("body"));

    const report = await createReport("proj-delete", "Report", ["finding-1"]);
    await deleteReport(report.id);
    expect(getReport(report.id)).toBeUndefined();

    await expect(deleteReport(report.id)).rejects.toThrow(ReportNotFoundError);
  });
});
