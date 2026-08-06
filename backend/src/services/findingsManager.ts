import { randomUUID } from "node:crypto";
import { listProjectIds, readProjectJson, writeProjectJson } from "./projectStore.js";
import { parseExecutionOutput } from "../parsers/index.js";
import { queryNvd } from "./cveLookup.js";
import { FindingNotFoundError } from "./errors.js";
import type {
  Finding,
  FindingCreateInput,
  FindingFilters,
  FindingPatchInput,
  FindingType,
  FindingsGraph,
  FindingsGraphNode,
  ParsedFinding,
} from "../types/finding.js";
import type { ExecutionRecord } from "../types/execTool.js";

const findings = new Map<string, Finding>();
const FINDINGS_FILE = "findings.json";
/** Caps how large a single finding's merged evidence can grow across repeated re-detections. */
const EVIDENCE_MAX_LEN = 4000;

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
    for (const finding of onDisk) findings.set(finding.id, finding);
  }
}

function computeDedupeKey(f: { projectId: string; type: FindingType; target: string; value: string }): string {
  return `${f.projectId}::${f.type}::${f.target.toLowerCase()}::${f.value.toLowerCase()}`;
}

function findExistingByKey(projectId: string, type: FindingType, target: string, value: string): Finding | undefined {
  const key = computeDedupeKey({ projectId, type, target, value });
  return projectFindings(projectId).find((f) => computeDedupeKey(f) === key);
}

/**
 * Creates a new Finding or, if one already exists for the same (projectId, type, target, value),
 * updates it in place instead of creating a duplicate: bumps lastSeenAt/sourceCount/confidence,
 * merges evidence and metadata, and logs a history entry. A human-set "verified"/"dismissed"
 * status is preserved across re-detection (only "discovered"/"updated" statuses advance).
 */
async function upsertFinding(
  projectId: string,
  parsed: ParsedFinding,
  source: Finding["source"],
): Promise<Finding> {
  const now = Date.now();
  const existing = findExistingByKey(projectId, parsed.type, parsed.target, parsed.value);

  if (existing) {
    existing.lastSeenAt = now;
    existing.updatedAt = now;
    existing.confidence = Math.max(existing.confidence, parsed.confidence);
    existing.sourceCount += 1;
    existing.metadata = { ...existing.metadata, ...parsed.metadata };
    if (parsed.evidence && !existing.evidence.includes(parsed.evidence)) {
      existing.evidence = `${existing.evidence}\n---\n${parsed.evidence}`.slice(-EVIDENCE_MAX_LEN);
    }
    if (existing.status === "discovered" || existing.status === "updated") existing.status = "updated";
    existing.history.push({ status: "updated", at: now });
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
    metadata: parsed.metadata ?? {},
    evidence: parsed.evidence ?? "",
    tags: parsed.tags ?? [],
    status: "discovered",
    history: [{ status: "discovered", at: now }],
    sourceCount: 1,
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
  for (const p of parsed) touched.push(await upsertFinding(record.projectId, p, "scanner"));
  return touched;
}

/** Manual/API finding creation (POST /api/projects/:id/findings) - still goes through the same
 * dedup upsert as scanner-sourced findings, so a manually-logged finding collapses into an
 * existing one rather than creating a parallel duplicate. */
export async function createFinding(projectId: string, input: FindingCreateInput): Promise<Finding> {
  const parsed: ParsedFinding = {
    type: input.type,
    severity: input.severity,
    title: input.title,
    description: input.description,
    tool: input.tool ?? "manual",
    confidence: input.confidence ?? 1,
    target: input.target,
    value: input.value,
    metadata: input.metadata,
    evidence: input.evidence,
    tags: input.tags,
  };
  return upsertFinding(projectId, parsed, "manual");
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
      (!filters.tag || f.tags.includes(filters.tag)),
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

const GRAPHABLE_TYPES: readonly FindingType[] = [
  "port",
  "service",
  "technology",
  "potential_vulnerability",
  "confirmed_vulnerability",
  "credential",
  "api",
  "directory",
  "endpoint",
  "subdomain",
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
