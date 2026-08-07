import { randomUUID } from "node:crypto";
import { getAgent } from "./agentManager.js";
import { streamAgentChat } from "./chatService.js";
import { getFinding } from "./findingsManager.js";
import { listProjectIds, readProjectJson, writeProjectJson } from "./projectStore.js";
import { FindingNotFoundError, NoFindingsSelectedError, ReportNotFoundError } from "./errors.js";
import type { Report, ReportSection } from "../types/report.js";
import type { Finding } from "../types/finding.js";

const reports = new Map<string, Report>();
const REPORTS_FILE = "reports.json";

/** The agent whose systemPrompt ("write a clear, professional bug bounty report...") is exactly
 * this feature's use case (backend/data/agents/report-writer.json) - reused directly, same as
 * FindingDetails.tsx's "Explain with AI" reuses the Vulnerability Validator agent rather than
 * adding a dedicated one. */
const DEFAULT_AGENT_ID = "report-writer";

function projectReports(projectId: string): Report[] {
  return [...reports.values()].filter((r) => r.projectId === projectId).sort((a, b) => b.createdAt - a.createdAt);
}

async function persistReports(projectId: string): Promise<void> {
  await writeProjectJson(projectId, REPORTS_FILE, projectReports(projectId));
}

/** Hydrates in-memory reports from disk - called once at server startup so report history
 * survives a restart, same pattern as every other project-scoped store (executions/tasks/scans). */
export async function loadReportsFromDisk(): Promise<void> {
  const projectIds = await listProjectIds();
  for (const projectId of projectIds) {
    const records = await readProjectJson<Report>(projectId, REPORTS_FILE);
    for (const record of records) reports.set(record.id, record);
  }
}

export function listReports(projectId: string): Report[] {
  return projectReports(projectId);
}

export function getReport(id: string): Report | undefined {
  return reports.get(id);
}

export async function deleteReport(id: string): Promise<void> {
  const report = reports.get(id);
  if (!report) throw new ReportNotFoundError(id);
  reports.delete(id);
  await persistReports(report.projectId);
}

function buildPrompt(title: string, findings: Finding[]): string {
  const findingsBlock = findings
    .map((f, i) =>
      [
        `### Finding ${i + 1}: ${f.title}`,
        `- Type: ${f.type}`,
        `- Severity: ${f.severity}`,
        `- Target: ${f.target}`,
        `- Tool: ${f.tool}`,
        `- Confidence: ${Math.round(f.confidence * 100)}%`,
        `- Description: ${f.description || "(none provided)"}`,
        "- Evidence:",
        f.evidence || "(none)",
      ].join("\n"),
    )
    .join("\n\n");

  return [
    `Write a professional security assessment report titled "${title}" covering the following ` +
      `${findings.length} finding(s).`,
    'Structure it in Markdown: a "## Executive Summary" section first, then one ' +
      '"## Finding: <title>" section per finding below - each finding section should cover ' +
      "Impact, Reproduction Steps, and Recommended Remediation as its own subsections.",
    "Write in a clear, professional tone suitable for a bug bounty program (HackerOne/Bugcrowd " +
      "style). Do not invent details that aren't supported by the finding data below - if " +
      "reproduction steps aren't derivable from the evidence given, say so explicitly rather than " +
      "fabricating them.",
    "",
    "---",
    "",
    findingsBlock,
  ].join("\n");
}

/**
 * Splits generated Markdown on "## " (H2) headings into sections. Deliberately lenient - like
 * orchestrator.ts#parseToolRequest's fence-stripping fallback for tool-request JSON, local models
 * don't always follow the requested structure exactly, so a report that skips or reflows the
 * requested headings still round-trips as one whole-document section instead of silently losing
 * content.
 */
export function splitSections(markdown: string): ReportSection[] {
  const lines = markdown.split("\n");
  const sections: ReportSection[] = [];
  let current: ReportSection | null = null;

  for (const line of lines) {
    const match = line.match(/^##\s+(.*)/);
    if (match) {
      current = { heading: match[1].trim(), content: "" };
      sections.push(current);
    } else if (current) {
      current.content += (current.content ? "\n" : "") + line;
    }
  }

  if (sections.length === 0) {
    const trimmed = markdown.trim();
    return trimmed ? [{ heading: "Report", content: trimmed }] : [];
  }
  return sections.map((s) => ({ ...s, content: s.content.trim() }));
}

/**
 * Generates one report from a set of findings via a single agent call (no tool loop - this is a
 * one-shot writeup, not an Orchestrator task) and persists it. Streams the agent's reply text as
 * it's generated via `onChunk`, same live-writing UX as chat/orchestrator streaming, then resolves
 * with the final persisted Report once generation completes.
 */
export async function createReport(
  projectId: string,
  title: string,
  findingIds: string[],
  onChunk?: (content: string) => void,
  signal?: AbortSignal,
  agentId: string = DEFAULT_AGENT_ID,
  model?: string,
): Promise<Report> {
  if (findingIds.length === 0) throw new NoFindingsSelectedError();

  const findings = findingIds.map((id) => {
    const finding = getFinding(id);
    if (!finding) throw new FindingNotFoundError(id);
    return finding;
  });

  let markdown = "";
  for await (const chunk of streamAgentChat(
    { agentId, messages: [{ role: "user", content: buildPrompt(title, findings) }], model },
    signal,
  )) {
    const piece = chunk.message?.content ?? "";
    if (piece) {
      onChunk?.(piece);
      markdown += piece;
    }
  }

  const agent = await getAgent(agentId);
  const report: Report = {
    id: randomUUID(),
    projectId,
    title,
    findingIds,
    agentId,
    model: model ?? agent?.model ?? "unknown",
    markdown,
    sections: splitSections(markdown),
    createdAt: Date.now(),
  };
  reports.set(report.id, report);
  await persistReports(projectId);
  return report;
}
