import { randomUUID } from "node:crypto";
import { listProjectIds, readProjectJson, writeProjectJson } from "./projectStore.js";
import { parseExecutionOutput } from "../parsers/index.js";
import { queryNvd } from "./cveLookup.js";
import { FindingNotFoundError } from "./errors.js";
import type {
  EvidenceItem,
  EvidenceType,
  Finding,
  FindingCreateInput,
  FindingFilters,
  FindingPatchInput,
  FindingStatus,
  FindingType,
  FindingsGraph,
  FindingsGraphNode,
  ParsedFinding,
} from "../types/finding.js";
import type { ExecutionRecord } from "../types/execTool.js";

const findings = new Map<string, Finding>();
const FINDINGS_FILE = "findings.json";
/** Caps how many evidence items a single finding retains across repeated re-detections - oldest
 * dropped first, so this is a rolling window, not a hard loss of the finding's origin (the first
 * item, from creation, is what usually matters most; see pushEvidence). */
const EVIDENCE_MAX_ITEMS = 20;

/** Maps a finding's old status vocabulary (discovered/updated/verified/dismissed) onto the current
 * one (potential/investigating/confirmed/false_positive/reported/duplicate) - applied to every
 * finding and history entry loaded from disk, so pre-existing project data written under the old
 * vocabulary keeps working without a manual migration step. Values already in the new vocabulary
 * pass through unchanged (idempotent), which is what makes this safe to run on every load. */
const STATUS_MIGRATION: Record<string, FindingStatus> = {
  discovered: "potential",
  updated: "potential",
  verified: "confirmed",
  dismissed: "false_positive",
};

function migrateStatus(status: string): FindingStatus {
  return (STATUS_MIGRATION[status] ?? status) as FindingStatus;
}

/** Applied to every finding loaded from disk - besides the status migration above, backfills
 * `executionIds`/`relatedAgents` (added after they might not exist on disk yet) and wraps a
 * pre-existing plain-string `evidence` (the old shape) into today's EvidenceItem array. */
function migrateFinding(finding: Finding): Finding {
  finding.status = migrateStatus(finding.status);
  for (const entry of finding.history) entry.status = migrateStatus(entry.status);
  finding.executionIds ??= [];
  finding.relatedAgents ??= [];
  const legacyEvidence = finding.evidence as unknown;
  if (typeof legacyEvidence === "string") {
    finding.evidence = legacyEvidence ? [{ type: "note", content: legacyEvidence, createdAt: finding.createdAt }] : [];
  }
  return finding;
}

function projectFindings(projectId: string): Finding[] {
  return [...findings.values()].filter((f) => f.projectId === projectId).sort((a, b) => b.updatedAt - a.updatedAt);
}

async function persistFindings(projectId: string): Promise<void> {
  await writeProjectJson(projectId, FINDINGS_FILE, projectFindings(projectId));
}

/** Hydrates in-memory findings from disk - called once at server startup, mirrors
 * loadTasksFromDisk()/loadExecutionsFromDisk(). */
export async function loadFindingsFromDisk(): Promise<void> {
  const projectIds = await listProjectIds();
  for (const projectId of projectIds) {
    const onDisk = await readProjectJson<Finding>(projectId, FINDINGS_FILE);
    for (const finding of onDisk) findings.set(finding.id, migrateFinding(finding));
  }
}

/** Which EvidenceType a raw evidence string defaults to, based on who produced the finding. */
function defaultEvidenceType(source: Finding["source"]): EvidenceType {
  if (source === "scanner") return "tool_result";
  if (source === "agent") return "agent_reasoning";
  return "note";
}

function pushEvidence(finding: Finding, item: EvidenceItem): void {
  if (finding.evidence.some((e) => e.content === item.content)) return;
  finding.evidence.push(item);
  if (finding.evidence.length > EVIDENCE_MAX_ITEMS) finding.evidence.splice(0, finding.evidence.length - EVIDENCE_MAX_ITEMS);
}

function computeDedupeKey(f: { projectId: string; type: FindingType; target: string; value: string }): string {
  return `${f.projectId}::${f.type}::${f.target.toLowerCase()}::${f.value.toLowerCase()}`;
}

function findExistingByKey(projectId: string, type: FindingType, target: string, value: string): Finding | undefined {
  const key = computeDedupeKey({ projectId, type, target, value });
  return projectFindings(projectId).find((f) => computeDedupeKey(f) === key);
}

interface UpsertOptions {
  /** The ExecutionRecord that produced/re-observed this finding, if any (scanner path). */
  executionId?: string;
  /** The agent that created this finding, if any (create_finding pseudo-tool path). */
  agentId?: string;
}

/**
 * Creates a new Finding or, if one already exists for the same (projectId, type, target, value),
 * updates it in place instead of creating a duplicate: bumps lastSeenAt/sourceCount/confidence,
 * merges evidence and metadata, links the triggering execution/agent, and logs a history entry.
 * A human/agent-set status past "potential" (investigating/confirmed/false_positive/reported/
 * duplicate) is preserved across re-detection - only "potential" findings advance (in place, so
 * this is a no-op status-wise, but the history entry below still records the re-observation).
 */
async function upsertFinding(
  projectId: string,
  parsed: ParsedFinding,
  source: Finding["source"],
  opts: UpsertOptions = {},
): Promise<Finding> {
  const now = Date.now();
  const existing = findExistingByKey(projectId, parsed.type, parsed.target, parsed.value);

  if (existing) {
    existing.lastSeenAt = now;
    existing.updatedAt = now;
    existing.confidence = Math.max(existing.confidence, parsed.confidence);
    existing.sourceCount += 1;
    existing.metadata = { ...existing.metadata, ...parsed.metadata };
    if (parsed.parameter !== undefined) existing.parameter = parsed.parameter;
    if (parsed.impact !== undefined) existing.impact = parsed.impact;
    if (parsed.reproductionSteps !== undefined) existing.reproductionSteps = parsed.reproductionSteps;
    if (parsed.evidence) pushEvidence(existing, { type: defaultEvidenceType(source), content: parsed.evidence, createdAt: now });
    if (opts.executionId && !existing.executionIds.includes(opts.executionId)) existing.executionIds.push(opts.executionId);
    if (opts.agentId && !existing.relatedAgents.includes(opts.agentId)) existing.relatedAgents.push(opts.agentId);
    if (existing.status === "potential") existing.status = "potential";
    existing.history.push({ status: existing.status, at: now });
    findings.set(existing.id, existing);
    await persistFindings(projectId);
    return existing;
  }

  const created: Finding = {
    id: randomUUID(),
    projectId,
    type: parsed.type,
    severity: parsed.severity,
    title: parsed.title,
    description: parsed.description,
    source,
    tool: parsed.tool,
    confidence: parsed.confidence,
    target: parsed.target,
    value: parsed.value,
    parameter: parsed.parameter,
    impact: parsed.impact,
    reproductionSteps: parsed.reproductionSteps,
    metadata: parsed.metadata ?? {},
    evidence: parsed.evidence ? [{ type: defaultEvidenceType(source), content: parsed.evidence, createdAt: now }] : [],
    tags: parsed.tags ?? [],
    status: "potential",
    history: [{ status: "potential", at: now }],
    sourceCount: 1,
    executionIds: opts.executionId ? [opts.executionId] : [],
    relatedAgents: opts.agentId ? [opts.agentId] : [],
    firstSeenAt: now,
    lastSeenAt: now,
    createdAt: now,
    updatedAt: now,
  };
  findings.set(created.id, created);
  await persistFindings(projectId);
  return created;
}

/**
 * Execution -> Parser -> Findings Engine -> Project Findings. Looks up a parser for the
 * execution's tool, extracts findings from its stdout, and upserts each one. Never throws - a
 * parsing failure must never break the actual tool-execution flow (see toolManager.ts's call site).
 * Returns `[]` for tools with no registered parser or a failed/unsuccessful execution.
 */
export async function ingestExecution(record: ExecutionRecord): Promise<Finding[]> {
  if (!record.result?.success) return [];
  const parsed = parseExecutionOutput(record.toolId, record.arguments, record.result.stdout);
  if (parsed.length === 0) return [];

  const touched: Finding[] = [];
  for (const p of parsed) touched.push(await upsertFinding(record.projectId, p, "scanner", { executionId: record.id }));
  return touched;
}

function parsedFromCreateInput(input: FindingCreateInput, defaultTool: string): ParsedFinding {
  return {
    type: input.type,
    severity: input.severity,
    title: input.title,
    description: input.description,
    tool: input.tool ?? defaultTool,
    confidence: input.confidence ?? 1,
    target: input.target,
    value: input.value,
    parameter: input.parameter,
    impact: input.impact,
    reproductionSteps: input.reproductionSteps,
    metadata: input.metadata,
    evidence: input.evidence,
    tags: input.tags,
  };
}

/** Manual finding creation (POST /api/projects/:id/findings) - still goes through the same dedup
 * upsert as scanner-sourced findings, so a manually-logged finding collapses into an existing one
 * rather than creating a parallel duplicate. */
export async function createFinding(projectId: string, input: FindingCreateInput): Promise<Finding> {
  return upsertFinding(projectId, parsedFromCreateInput(input, "manual"), "manual");
}

/** Agent-tool path (see orchestrator.ts's create_finding pseudo-tool) - the task's headline ask for
 * this system: an agent can record a structured finding directly instead of only describing one in
 * plain text. Stamps `relatedAgents` with the creating agent, same dedup/upsert behavior as above. */
export async function createAgentFinding(projectId: string, agentId: string, input: FindingCreateInput): Promise<Finding> {
  return upsertFinding(projectId, parsedFromCreateInput(input, agentId), "agent", { agentId });
}

async function performCveLookup(
  projectId: string,
  keyword: string,
  target: string,
  sourceFindingId?: string,
): Promise<Finding[]> {
  const results = await queryNvd(keyword);
  const touched: Finding[] = [];
  for (const r of results) {
    const parsed: ParsedFinding = {
      type: "cve",
      severity: r.cvssSeverity,
      title: r.id,
      description: r.description,
      tool: "nvd",
      confidence: 0.7,
      target,
      value: r.id,
      metadata: {
        cvssScore: r.cvssScore,
        cvssVector: r.cvssVector,
        references: r.references,
        ...(sourceFindingId ? { sourceFindingId } : {}),
      },
      evidence: r.description,
    };
    touched.push(await upsertFinding(projectId, parsed, "scanner"));
  }
  return touched;
}

/** UI-button path (POST /api/findings/:id/cve-lookup) - links each discovered CVE back to the
 * finding that triggered the lookup via metadata.sourceFindingId (so buildFindingsGraph can
 * connect them), and shares `target` with it (so they surface in its "Related Findings" too,
 * with zero extra frontend logic). */
export async function lookupCvesForFinding(findingId: string): Promise<Finding[]> {
  const finding = findings.get(findingId);
  if (!finding) throw new FindingNotFoundError(findingId);
  return performCveLookup(finding.projectId, finding.title, finding.target, finding.id);
}

/** Agent-tool path (see orchestrator.ts's lookup_cves pseudo-tool) - no pre-existing finding to
 * link against, so the caller supplies the keyword and target directly. */
export async function lookupCvesByKeyword(projectId: string, keyword: string, target: string): Promise<Finding[]> {
  return performCveLookup(projectId, keyword, target);
}

export async function updateFinding(id: string, patch: FindingPatchInput): Promise<Finding> {
  const finding = findings.get(id);
  if (!finding) throw new FindingNotFoundError(id);

  const now = Date.now();
  if (patch.status !== undefined && patch.status !== finding.status) {
    finding.status = patch.status;
    finding.history.push({ status: patch.status, at: now });
  }
  if (patch.severity !== undefined) finding.severity = patch.severity;
  if (patch.tags !== undefined) finding.tags = patch.tags;
  if (patch.description !== undefined) finding.description = patch.description;
  if (patch.title !== undefined) finding.title = patch.title;
  if (patch.confidence !== undefined) finding.confidence = patch.confidence;
  if (patch.parameter !== undefined) finding.parameter = patch.parameter;
  if (patch.impact !== undefined) finding.impact = patch.impact;
  if (patch.reproductionSteps !== undefined) finding.reproductionSteps = patch.reproductionSteps;
  finding.updatedAt = now;

  findings.set(finding.id, finding);
  await persistFindings(finding.projectId);
  return finding;
}

export async function deleteFinding(id: string): Promise<void> {
  const finding = findings.get(id);
  if (!finding) throw new FindingNotFoundError(id);
  findings.delete(id);
  await persistFindings(finding.projectId);
}

export function getFinding(id: string): Finding | undefined {
  return findings.get(id);
}

export function listFindings(projectId: string, filters: FindingFilters = {}): Finding[] {
  return projectFindings(projectId).filter(
    (f) =>
      (!filters.type || f.type === filters.type) &&
      (!filters.severity || f.severity === filters.severity) &&
      (!filters.tool || f.tool === filters.tool) &&
      (!filters.target || f.target === filters.target) &&
      (!filters.tag || f.tags.includes(filters.tag)) &&
      (filters.minConfidence === undefined || f.confidence >= filters.minConfidence) &&
      (!filters.agent || f.tool === filters.agent || f.relatedAgents.includes(filters.agent)),
  );
}

export function searchFindings(projectId: string, query: string): Finding[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  return projectFindings(projectId).filter((f) =>
    [f.title, f.description, f.target, f.tool, f.value, ...f.tags].some((field) => field.toLowerCase().includes(q)),
  );
}

// --- Agent-facing query helpers (exact names from the spec) ---

export const getProjectFindings = (projectId: string): Finding[] => projectFindings(projectId);
export const getPorts = (projectId: string): Finding[] => listFindings(projectId, { type: "port" });
export const getTechnologies = (projectId: string): Finding[] => listFindings(projectId, { type: "technology" });
export const getDirectories = (projectId: string): Finding[] => listFindings(projectId, { type: "directory" });
export const getVulnerabilities = (projectId: string): Finding[] =>
  projectFindings(projectId).filter((f) => f.type === "potential_vulnerability" || f.type === "confirmed_vulnerability");

// --- Correlation graph (heuristic v1 - target-string matching, plus on-demand NVD CVE lookups) ---

// Every FindingType is graphable - the frontend graph renderer (FindingsGraphView.tsx#NODE_TONE)
// already has a colour for all 16, so anything discovered for a target belongs on its mind map.
// A whois/DNS-only recon pass produces solely "information"/"domain" findings; excluding those
// (as an earlier revision did) left the graph empty despite real findings existing. Types without
// special edge handling below fall through to the catch-all target->finding "contains" edge.
const GRAPHABLE_TYPES: readonly FindingType[] = [
  "port",
  "service",
  "technology",
  "domain",
  "subdomain",
  "directory",
  "endpoint",
  "credential",
  "cookie",
  "api",
  "header",
  "interesting_file",
  "potential_vulnerability",
  "confirmed_vulnerability",
  "information",
  "cve",
];

export function buildFindingsGraph(projectId: string): FindingsGraph {
  const graphable = projectFindings(projectId).filter((f) => GRAPHABLE_TYPES.includes(f.type));
  const nodes = new Map<string, FindingsGraphNode>();
  const edges: FindingsGraph["edges"] = [];
  const portNodeIdByTargetPort = new Map<string, string>();

  const ensureTargetNode = (target: string): string => {
    const id = `target:${target}`;
    if (!nodes.has(id)) nodes.set(id, { id, type: "target", label: target });
    return id;
  };
  const ensureToolNode = (tool: string): string => {
    const id = `tool:${tool}`;
    if (!nodes.has(id)) nodes.set(id, { id, type: "tool", label: tool });
    return id;
  };

  // Every graphable finding gets a node up front, in one pass, before any edges are built - a cve
  // finding's edge needs to reference its source finding's node (metadata.sourceFindingId), and
  // that source finding isn't guaranteed to sort earlier in `graphable` (findings are ordered by
  // updatedAt desc, and a freshly-looked-up CVE is typically *more* recently updated than the
  // technology finding that triggered the lookup).
  for (const f of graphable) nodes.set(f.id, { id: f.id, type: f.type, label: f.title });

  // Ports next, so service/technology findings below can link to the specific port they run on.
  for (const f of graphable.filter((f) => f.type === "port")) {
    edges.push({ source: ensureTargetNode(f.target), target: f.id, relation: "runs_on" });
    const port = f.metadata?.port as number | undefined;
    if (port !== undefined) portNodeIdByTargetPort.set(`${f.target}:${port}`, f.id);
  }

  for (const f of graphable.filter((f) => f.type !== "port")) {
    if (f.type === "service" || f.type === "technology") {
      const port = f.metadata?.port as number | undefined;
      const portNodeId = port !== undefined ? portNodeIdByTargetPort.get(`${f.target}:${port}`) : undefined;
      edges.push({ source: portNodeId ?? ensureTargetNode(f.target), target: f.id, relation: "uses" });
    } else if (f.type === "potential_vulnerability" || f.type === "confirmed_vulnerability") {
      edges.push({ source: ensureTargetNode(f.target), target: f.id, relation: "related_to" });
    } else if (f.type === "cve") {
      const sourceFindingId = f.metadata?.sourceFindingId as string | undefined;
      const sourceNodeId = sourceFindingId && nodes.has(sourceFindingId) ? sourceFindingId : ensureTargetNode(f.target);
      edges.push({ source: sourceNodeId, target: f.id, relation: "related_to" });
    } else if (f.type === "subdomain") {
      const parent = (f.metadata?.parentDomain as string | undefined) ?? f.target;
      edges.push({ source: ensureTargetNode(parent), target: f.id, relation: "connected_to" });
    } else {
      edges.push({ source: ensureTargetNode(f.target), target: f.id, relation: "contains" });
    }
  }

  for (const f of graphable) edges.push({ source: f.id, target: ensureToolNode(f.tool), relation: "discovered_by" });

  return { nodes: [...nodes.values()], edges };
}
