import { randomUUID } from "node:crypto";
import { listMissionIds, readMissionJson, writeMissionJson } from "./missionStore.js";
import { parseExecutionOutput } from "../parsers/index.js";
import { queryNvd } from "./cveLookup.js";
import { FindingNotFoundError } from "./errors.js";
import { onMissionDeleted } from "./missionManager.js";
import { getAssetByValue, upsertAsset } from "./assetManager.js";
import { logActivity } from "./activityLog.js";
import type { AssetType } from "../types/asset.js";
import type {
  EvidenceItem,
  EvidenceType,
  Finding,
  FindingCreateInput,
  FindingFilters,
  FindingPatchInput,
  FindingSeverity,
  FindingStatus,
  FindingType,
  ParsedFinding,
} from "../types/finding.js";
import type { ExecutionRecord } from "../types/execTool.js";

const findings = new Map<string, Finding>();
const FINDINGS_FILE = "findings.json";
/** Caps how many evidence items a single finding retains across repeated re-detections - oldest
 * dropped first, so this is a rolling window, not a hard loss of the finding's origin (the first
 * item, from creation, is what usually matters most; see pushEvidence). */
const EVIDENCE_MAX_ITEMS = 20;
/** Same rolling cap for history - every re-detection appends an entry, so a scan re-run on a schedule
 * would otherwise grow each finding (and the whole-file findings.json rewrite) without bound. */
const HISTORY_MAX_ENTRIES = 50;

/** Maps a finding's old status vocabulary (discovered/updated/verified/dismissed) onto the current
 * one (potential/investigating/confirmed/false_positive/reported/duplicate) - applied to every
 * finding and history entry loaded from disk, so pre-existing mission data written under the old
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
    finding.evidence = legacyEvidence
      ? [{ id: randomUUID(), type: "note", content: legacyEvidence, createdAt: finding.createdAt }]
      : [];
  }
  // Every evidence item written before the id/agentId/executionId fields existed is backfilled with
  // a fresh id here - see types/finding.ts's EvidenceItem doc comment.
  for (const item of finding.evidence) {
    if (!item.id) item.id = randomUUID();
  }
  return finding;
}

function missionFindings(missionId: string): Finding[] {
  return [...findings.values()].filter((f) => f.missionId === missionId).sort((a, b) => b.updatedAt - a.updatedAt);
}

async function persistFindings(missionId: string): Promise<void> {
  await writeMissionJson(missionId, FINDINGS_FILE, missionFindings(missionId));
}

// See missionManager.ts#onMissionDeleted - a deleted mission's findings must stop returning from
// queries/the Findings dashboard instead of lingering as ghost records.
onMissionDeleted((missionId) => {
  for (const [id, finding] of findings) {
    if (finding.missionId === missionId) findings.delete(id);
  }
});

/** Hydrates in-memory findings from disk - called once at server startup, mirrors
 * loadTasksFromDisk()/loadExecutionsFromDisk(). */
export async function loadFindingsFromDisk(): Promise<void> {
  const missionIds = await listMissionIds();
  for (const missionId of missionIds) {
    const onDisk = await readMissionJson<Finding>(missionId, FINDINGS_FILE);
    for (const finding of onDisk) findings.set(finding.id, migrateFinding(finding));
  }
}

/** Which EvidenceType a raw evidence string defaults to, based on who produced the finding. */
function defaultEvidenceType(source: Finding["source"]): EvidenceType {
  if (source === "scanner") return "tool_result";
  if (source === "agent") return "agent_reasoning";
  return "note";
}

function pushEvidence(finding: Finding, item: Omit<EvidenceItem, "id">): void {
  if (finding.evidence.some((e) => e.content === item.content)) return;
  finding.evidence.push({ id: randomUUID(), ...item });
  if (finding.evidence.length > EVIDENCE_MAX_ITEMS) finding.evidence.splice(0, finding.evidence.length - EVIDENCE_MAX_ITEMS);
}

function computeDedupeKey(f: { missionId: string; type: FindingType; target: string; value: string }): string {
  return `${f.missionId}::${f.type}::${f.target.toLowerCase()}::${f.value.toLowerCase()}`;
}

function findExistingByKey(missionId: string, type: FindingType, target: string, value: string): Finding | undefined {
  const key = computeDedupeKey({ missionId, type, target, value });
  for (const f of findings.values()) {
    if (computeDedupeKey(f) === key) return f;
  }
  return undefined;
}

interface UpsertOptions {
  /** The ExecutionRecord that produced/re-observed this finding, if any (scanner path). */
  executionId?: string;
  /** The agent that created this finding, if any (create_finding pseudo-tool path). */
  agentId?: string;
}

/** Only a subset of FindingTypes correspond to a physical/logical asset - the rest (credential,
 * cookie, header, potential_vulnerability, cve, information, ...) describe something *about* an
 * asset, not the asset itself, and are deliberately left out of the Asset Inventory. */
const ASSET_TYPE_BY_FINDING_TYPE: Partial<Record<FindingType, AssetType>> = {
  domain: "domain",
  subdomain: "subdomain",
  port: "port",
  service: "service",
  technology: "technology",
  api: "api",
};

/**
 * Mirrors a newly-(re)observed Finding into the Asset Inventory from this single ingest chokepoint
 * (upsertFinding) rather than duplicating the mapping at every call site that can produce a finding
 * (scanner ingest, manual create, the create_finding pseudo-tool) - see services/assetManager.ts and
 * the factory spec's "centralized, not per-agent" requirement for asset discovery. Best-effort: a
 * failure here must never break finding creation itself, so it's caught and logged, not propagated.
 */
async function mirrorAssetFromFinding(
  missionId: string,
  finding: Pick<Finding, "type" | "target" | "value" | "metadata" | "tool" | "source">,
): Promise<void> {
  const assetType = ASSET_TYPE_BY_FINDING_TYPE[finding.type];
  if (!assetType) return;

  try {
    // Best-effort parent resolution: a subdomain's parent is its parent domain; a port/service/technology/api
    // finding's parent is whatever asset already exists for its `target` (a domain/subdomain/ip).
    const parentValue =
      finding.type === "subdomain"
        ? ((finding.metadata?.parentDomain as string | undefined) ?? finding.target)
        : finding.type !== "domain"
          ? finding.target
          : undefined;
    const parent = parentValue ? getAssetByValue(missionId, parentValue) : undefined;

    await upsertAsset(missionId, {
      type: assetType,
      value: finding.value,
      discoveredBy: finding.tool,
      source: finding.source,
      status: "active",
      parentId: parent?.id,
    });
  } catch (err) {
    console.error(`[findingsManager] failed to mirror finding into the Asset Inventory (mission "${missionId}"):`, err);
  }
}

/**
 * Creates a new Finding or, if one already exists for the same (missionId, type, target, value),
 * updates it in place instead of creating a duplicate: bumps lastSeenAt/sourceCount/confidence,
 * merges evidence and metadata, links the triggering execution/agent, and logs a history entry.
 * A human/agent-set status past "potential" (investigating/confirmed/false_positive/reported/
 * duplicate) is preserved across re-detection - only "potential" findings advance (in place, so
 * this is a no-op status-wise, but the history entry below still records the re-observation).
 */
async function upsertFinding(
  missionId: string,
  parsed: ParsedFinding,
  source: Finding["source"],
  opts: UpsertOptions = {},
): Promise<Finding> {
  const now = Date.now();
  const existing = findExistingByKey(missionId, parsed.type, parsed.target, parsed.value);

  if (existing) {
    existing.lastSeenAt = now;
    existing.updatedAt = now;
    existing.confidence = Math.max(existing.confidence, parsed.confidence);
    existing.sourceCount += 1;
    existing.metadata = { ...existing.metadata, ...parsed.metadata };
    if (parsed.parameter !== undefined) existing.parameter = parsed.parameter;
    if (parsed.impact !== undefined) existing.impact = parsed.impact;
    if (parsed.reproductionSteps !== undefined) existing.reproductionSteps = parsed.reproductionSteps;
    if (parsed.evidence) {
      pushEvidence(existing, {
        type: defaultEvidenceType(source),
        content: parsed.evidence,
        createdAt: now,
        agentId: opts.agentId,
        executionId: opts.executionId,
      });
    }
    if (opts.executionId && !existing.executionIds.includes(opts.executionId)) existing.executionIds.push(opts.executionId);
    if (opts.agentId && !existing.relatedAgents.includes(opts.agentId)) existing.relatedAgents.push(opts.agentId);
    existing.history.push({ status: existing.status, at: now });
    if (existing.history.length > HISTORY_MAX_ENTRIES) existing.history.splice(0, existing.history.length - HISTORY_MAX_ENTRIES);
    findings.set(existing.id, existing);
    await persistFindings(missionId);
    await mirrorAssetFromFinding(missionId, existing);
    return existing;
  }

  const created: Finding = {
    id: randomUUID(),
    missionId,
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
    evidence: parsed.evidence
      ? [
          {
            id: randomUUID(),
            type: defaultEvidenceType(source),
            content: parsed.evidence,
            createdAt: now,
            agentId: opts.agentId,
            executionId: opts.executionId,
          },
        ]
      : [],
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
  await persistFindings(missionId);
  await mirrorAssetFromFinding(missionId, created);
  await logActivity(missionId, "finding_created", `Finding created: ${created.title} (${created.severity})`, {
    findingId: created.id,
    severity: created.severity,
  });
  return created;
}

/**
 * Execution -> Parser -> Findings Engine -> Mission Findings. Looks up a parser for the
 * execution's tool, extracts findings from its stdout, and upserts each one. Never throws - a
 * parsing failure must never break the actual tool-execution flow (see toolManager.ts's call site).
 * Returns `[]` for tools with no registered parser or a failed/unsuccessful execution.
 */
export async function ingestExecution(record: ExecutionRecord): Promise<Finding[]> {
  if (!record.result?.success) return [];
  const parsed = parseExecutionOutput(record.toolId, record.arguments, record.result.stdout);
  if (parsed.length === 0) return [];

  const touched: Finding[] = [];
  for (const p of parsed) touched.push(await upsertFinding(record.missionId, p, "scanner", { executionId: record.id }));
  return touched;
}

/** Confidence renders as a percentage and feeds minConfidence filters - agents and API callers can
 * send anything. Out-of-range values clamp; a non-finite one falls back to full confidence, the same
 * as omitting it. */
function clampConfidence(confidence: number | undefined): number {
  if (confidence === undefined || !Number.isFinite(confidence)) return 1;
  return Math.min(1, Math.max(0, confidence));
}

function parsedFromCreateInput(input: FindingCreateInput, defaultTool: string): ParsedFinding {
  return {
    type: input.type,
    severity: input.severity,
    title: input.title,
    description: input.description,
    tool: input.tool ?? defaultTool,
    confidence: clampConfidence(input.confidence),
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

/** Manual finding creation (POST /api/missions/:id/findings) - still goes through the same dedup
 * upsert as scanner-sourced findings, so a manually-logged finding collapses into an existing one
 * rather than creating a parallel duplicate. */
export async function createFinding(missionId: string, input: FindingCreateInput): Promise<Finding> {
  return upsertFinding(missionId, parsedFromCreateInput(input, "manual"), "manual");
}

/** Agent-tool path (see orchestrator.ts's create_finding pseudo-tool) - the task's headline ask for
 * this system: an agent can record a structured finding directly instead of only describing one in
 * plain text. Stamps `relatedAgents` with the creating agent, same dedup/upsert behavior as above. */
export async function createAgentFinding(missionId: string, agentId: string, input: FindingCreateInput): Promise<Finding> {
  return upsertFinding(missionId, parsedFromCreateInput(input, agentId), "agent", { agentId });
}

async function performCveLookup(
  missionId: string,
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
    touched.push(await upsertFinding(missionId, parsed, "scanner"));
  }
  return touched;
}

/** UI-button path (POST /api/findings/:id/cve-lookup) - links each discovered CVE back to the
 * finding that triggered the lookup via metadata.sourceFindingId, and shares `target` with it (so
 * they surface in its "Related Findings" too, with zero extra frontend logic). */
export async function lookupCvesForFinding(findingId: string): Promise<Finding[]> {
  const finding = findings.get(findingId);
  if (!finding) throw new FindingNotFoundError(findingId);
  return performCveLookup(finding.missionId, finding.title, finding.target, finding.id);
}

/** Agent-tool path (see orchestrator.ts's lookup_cves pseudo-tool) - no pre-existing finding to
 * link against, so the caller supplies the keyword and target directly. */
export async function lookupCvesByKeyword(missionId: string, keyword: string, target: string): Promise<Finding[]> {
  return performCveLookup(missionId, keyword, target);
}

export async function updateFinding(id: string, patch: FindingPatchInput): Promise<Finding> {
  const finding = findings.get(id);
  if (!finding) throw new FindingNotFoundError(id);

  const now = Date.now();
  let statusChange: { from: FindingStatus; to: FindingStatus } | undefined;
  if (patch.status !== undefined && patch.status !== finding.status) {
    statusChange = { from: finding.status, to: patch.status };
    finding.status = patch.status;
    finding.history.push({ status: patch.status, at: now });
  }
  if (patch.severity !== undefined) finding.severity = patch.severity;
  if (patch.tags !== undefined) finding.tags = patch.tags;
  if (patch.description !== undefined) finding.description = patch.description;
  if (patch.title !== undefined) finding.title = patch.title;
  if (patch.confidence !== undefined) finding.confidence = clampConfidence(patch.confidence);
  if (patch.parameter !== undefined) finding.parameter = patch.parameter;
  if (patch.impact !== undefined) finding.impact = patch.impact;
  if (patch.reproductionSteps !== undefined) finding.reproductionSteps = patch.reproductionSteps;
  finding.updatedAt = now;

  findings.set(finding.id, finding);
  await persistFindings(finding.missionId);
  if (statusChange) {
    await logActivity(finding.missionId, "finding_status_changed", `Finding "${finding.title}" status changed: ${statusChange.from} -> ${statusChange.to}`, {
      findingId: finding.id,
      ...statusChange,
    });
  }
  return finding;
}

/**
 * Agent-tool path (see orchestrator.ts's validate_finding pseudo-tool) - the Validation pipeline's
 * terminal step (see the factory spec's Finding Validation flow): records a validator's verdict on
 * a finding, complete with the reasoning that led to it as a traceable, agent-attributed
 * EvidenceItem, rather than just flipping a status with no record of why.
 */
export async function validateFinding(
  findingId: string,
  agentId: string,
  verdict: "confirmed" | "false_positive" | "duplicate",
  notes: string,
  severity?: FindingSeverity,
): Promise<Finding> {
  const finding = findings.get(findingId);
  if (!finding) throw new FindingNotFoundError(findingId);

  const now = Date.now();
  if (finding.status !== verdict) {
    finding.status = verdict;
    finding.history.push({ status: verdict, at: now });
  }
  if (severity !== undefined) finding.severity = severity;
  finding.validatedBy = agentId;
  if (!finding.relatedAgents.includes(agentId)) finding.relatedAgents.push(agentId);
  pushEvidence(finding, { type: "agent_reasoning", content: notes, createdAt: now, agentId });
  finding.updatedAt = now;

  findings.set(finding.id, finding);
  await persistFindings(finding.missionId);
  await logActivity(finding.missionId, "finding_validated", `Finding "${finding.title}" validated: ${verdict}`, {
    findingId: finding.id,
    verdict,
    agentId,
  });
  return finding;
}

export async function deleteFinding(id: string): Promise<void> {
  const finding = findings.get(id);
  if (!finding) throw new FindingNotFoundError(id);
  findings.delete(id);
  await persistFindings(finding.missionId);
}

export function getFinding(id: string): Finding | undefined {
  return findings.get(id);
}

export function listFindings(missionId: string, filters: FindingFilters = {}): Finding[] {
  return missionFindings(missionId).filter(
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

export function searchFindings(missionId: string, query: string): Finding[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  return missionFindings(missionId).filter((f) =>
    [f.title, f.description, f.target, f.tool, f.value, ...f.tags].some((field) => field.toLowerCase().includes(q)),
  );
}

// --- Agent-facing query helpers (exact names from the spec) ---

export const getMissionFindings = (missionId: string): Finding[] => missionFindings(missionId);
export const getPorts = (missionId: string): Finding[] => listFindings(missionId, { type: "port" });
export const getTechnologies = (missionId: string): Finding[] => listFindings(missionId, { type: "technology" });
export const getDirectories = (missionId: string): Finding[] => listFindings(missionId, { type: "directory" });
export const getVulnerabilities = (missionId: string): Finding[] =>
  missionFindings(missionId).filter((f) => f.type === "potential_vulnerability" || f.type === "confirmed_vulnerability");
