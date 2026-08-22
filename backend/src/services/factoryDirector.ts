import { getMission, updateMission } from "./missionManager.js";
import { listAssets } from "./assetManager.js";
import { getMissionFindings } from "./findingsManager.js";
import { createWorkOrder, dependenciesSatisfied, listWorkOrders, startWorkOrder } from "./workOrderManager.js";
import { logActivity } from "./activityLog.js";
import { MissionNotFoundError } from "./errors.js";
import type { ChunkListener } from "./orchestrator.js";
import type { Mission, MissionStatus } from "../types/mission.js";
import type { Asset } from "../types/asset.js";
import type { Finding } from "../types/finding.js";
import type { WorkOrder } from "../types/workOrder.js";

/**
 * The Factory Director: reads a mission's scope/assets/findings/work orders and drives the factory
 * pipeline forward by creating and starting Security Work Orders - never a second execution
 * mechanism, every work order it starts runs through workOrderManager.ts#startWorkOrder, which
 * itself reuses services/orchestrator.ts exactly (the same reuse pattern
 * multiAgentOrchestrator.ts#createPlan already established one level down). Request-driven, not a
 * background timer, consistent with the rest of this app: POST /api/missions/:id/factory/advance
 * (routes/missions.ts) runs one advanceMission() call, which auto-chains through everything that
 * doesn't need human approval and pauses at the same "waiting_approval" point a work order's own
 * underlying OrchestratorTask would pause at - the caller (frontend) calls advance again after the
 * pending confirmation is resolved, exactly the contract multiAgentOrchestrator.ts's resumePlan
 * already has for its own pause points.
 */

const RECON_AGENT_ID = "recon-agent";
const WEB_ANALYZER_AGENT_ID = "web-analyzer";
const VALIDATOR_AGENT_ID = "vulnerability-validator";

/** Asset types worth an Enumeration work order - a port/service/api/technology is already the
 * *result* of enumerating a host, not something to enumerate further. */
const ENUMERABLE_ASSET_TYPES: Asset["type"][] = ["domain", "subdomain", "ip"];

const UNSETTLED_FINDING_STATUSES: Finding["status"][] = ["potential", "investigating"];

/** A work order that's still pending/queued/running/waiting on a human - the only state worth
 * deduping a fresh Recon/Validation seed against. A `completed`/`failed`/`cancelled` one is
 * history, not a reason to refuse trying again *for these two specifically*, because both already
 * have an outer condition tied directly to the observable outcome (`assets.length === 0` for
 * Recon, `UNSETTLED_FINDING_STATUSES` for Validation) - if that condition is still true, whatever
 * the previous attempt did wasn't enough, regardless of why (an agent that declined to act because
 * the mission had no scope yet at the time, a `failed` execution, or anything else). The fresh
 * advance() call a human makes by clicking the button again *is* the attention that class of
 * non-outcome needs, not a reason to wedge the pipeline forever. See TODO.md's "Known issues" entry
 * this fixes. Enumeration doesn't get this treatment - see `hasBlockingWorkOrder` below for why. */
const IN_PROGRESS_WORK_ORDER_STATUSES: WorkOrder["status"][] = ["pending", "queued", "running", "waiting_approval"];

function hasInProgressWorkOrder(existing: WorkOrder[], predicate: (wo: WorkOrder) => boolean): boolean {
  return existing.some((wo) => IN_PROGRESS_WORK_ORDER_STATUSES.includes(wo.status) && predicate(wo));
}

/** Enumeration has no equivalent outer "didn't work yet" signal - a `completed` Enumeration work
 * order for a given asset generally did produce real analysis (findings, even if no *new* assets),
 * so unlike Recon/Validation it must stay permanently deduped once completed - re-seeding it on
 * every `advanceMission` call would mean re-analyzing the same asset forever. Only a genuine
 * non-outcome (`failed`/`cancelled`) is worth retrying. */
function hasBlockingWorkOrder(existing: WorkOrder[], predicate: (wo: WorkOrder) => boolean): boolean {
  return existing.some((wo) => predicate(wo) && wo.status !== "failed" && wo.status !== "cancelled");
}

/**
 * Deterministic, rule-based work planning for v1 (see the plan's Design call #1) - reliable and
 * testable end-to-end without depending on an LLM planning call. Idempotent against *concurrent*
 * duplicates (never seeds a second work order while a matching one is still in progress).
 */
async function seedWorkOrders(mission: Mission, assets: Asset[], findings: Finding[], existing: WorkOrder[]): Promise<void> {
  if (assets.length === 0 && mission.scope?.length && !hasInProgressWorkOrder(existing, (wo) => wo.agentId === RECON_AGENT_ID)) {
    await createWorkOrder(mission.id, {
      agentId: RECON_AGENT_ID,
      objective:
        `Perform initial reconnaissance on this mission's in-scope targets: ${mission.scope.join(", ")}. Discover ` +
        "subdomains, open ports, and running services, and register each one via the upsert_asset tool " +
        "(or let create_finding's automatic asset-mirroring do it for you when you log a domain/" +
        "subdomain/port/service/technology finding).",
      target: mission.scope[0],
      priority: 10,
    });
  }

  for (const asset of assets) {
    if (!ENUMERABLE_ASSET_TYPES.includes(asset.type)) continue;
    if (hasBlockingWorkOrder(existing, (wo) => wo.agentId === WEB_ANALYZER_AGENT_ID && wo.target === asset.value)) continue;
    await createWorkOrder(mission.id, {
      agentId: WEB_ANALYZER_AGENT_ID,
      objective:
        `Enumerate and analyze "${asset.value}" (${asset.type}) for this mission - identify running ` +
        "services, technologies, and potential attack surface. Record anything notable via " +
        "create_finding, and any further assets you discover via upsert_asset.",
      target: asset.value,
      priority: 5,
      relatedAssets: [asset.id],
    });
  }

  for (const finding of findings) {
    if (!UNSETTLED_FINDING_STATUSES.includes(finding.status)) continue;
    if (hasInProgressWorkOrder(existing, (wo) => wo.agentId === VALIDATOR_AGENT_ID && wo.relatedFindings.includes(finding.id))) continue;
    await createWorkOrder(mission.id, {
      agentId: VALIDATOR_AGENT_ID,
      objective:
        `Validate finding "${finding.title}" (id: ${finding.id}, target: ${finding.target}) for this ` +
        "mission. Use query_findings to review its full evidence, assess reproducibility, whether the " +
        "target is actually in scope, whether the evidence is sufficient, whether the impact is " +
        "realistic, and whether this is likely a duplicate - then call validate_finding with your verdict.",
      target: finding.target,
      priority: 8,
      relatedFindings: [finding.id],
    });
  }
}

/** The pipeline stages the Director itself owns/advances through - "review"/"completed"/"paused"/
 * "cancelled" are deliberately excluded (require an explicit human action, see the plan's Phase 3
 * section), so `stageIndex` returns -1 for any of those and `maybeAdvanceMissionStatus` below never
 * touches a mission a human has moved into one of them. */
const DIRECTOR_STAGES: MissionStatus[] = ["draft", "ready", "recon", "investigating", "validating", "reporting"];

function stageIndex(status: MissionStatus | undefined): number {
  if (!status) return -1;
  return DIRECTOR_STAGES.indexOf(status);
}

/** No assets yet -> "recon". Assets exist but findings still need triage -> "investigating", or
 * "validating" specifically once a Validation work order for one of them is actually in flight (not
 * just queued) - a real, observable distinction rather than a guess. No unsettled findings but
 * discovery/enumeration work orders are still outstanding -> still "investigating" (a mission with
 * one asset and zero findings yet hasn't finished looking, it just hasn't found anything to triage
 * *yet*). Only once nothing is left to run and no finding needs triage -> "reporting" (report
 * generation itself, and the move to "review"/"completed", stay explicit human actions). */
function computeStage(assets: Asset[], findings: Finding[], workOrders: WorkOrder[]): MissionStatus {
  if (assets.length === 0) return "recon";

  const unsettled = findings.filter((f) => UNSETTLED_FINDING_STATUSES.includes(f.status));
  if (unsettled.length > 0) {
    const validationInFlight = workOrders.some(
      (wo) => wo.agentId === VALIDATOR_AGENT_ID && (wo.status === "running" || wo.status === "waiting_approval"),
    );
    return validationInFlight ? "validating" : "investigating";
  }

  const stillWorking = workOrders.some((wo) => IN_PROGRESS_WORK_ORDER_STATUSES.includes(wo.status));
  return stillWorking ? "investigating" : "reporting";
}

/** Only moves a mission *forward* through the Director-owned stages, and only if it's currently
 * sitting in one of them - a mission a human has parked at "paused"/"cancelled"/"review"/"completed"
 * (stageIndex -1, but status is set) is left untouched; a never-advanced mission (status undefined)
 * always advances since -1 < any real target index. */
async function maybeAdvanceMissionStatus(mission: Mission, computed: MissionStatus): Promise<Mission> {
  const current = stageIndex(mission.status);
  if (current === -1 && mission.status !== undefined) return mission;
  const target = DIRECTOR_STAGES.indexOf(computed);
  if (target <= current) return mission;
  const updated = await updateMission(mission.id, { status: computed });
  await logActivity(mission.id, "mission_status_changed", `Mission status changed: ${mission.status ?? "(none)"} -> ${computed}`, {
    from: mission.status,
    to: computed,
  });
  return updated;
}

export interface FactoryAdvanceResult {
  mission: Mission;
  /** The work order this call started, if any - undefined means nothing was runnable (either the
   * mission has no pending work at all, or everything pending has unmet dependencies). */
  workOrder?: WorkOrder;
  /** Set when advanceMission did nothing and there's a specific, actionable reason a human should
   * see rather than just silence - currently only "no scope configured yet", the exact confusion
   * this field was added to fix (a mission created via the quick-create name+notes form has no
   * scope, so the Director correctly refuses to seed a Recon work order at all rather than sending
   * an agent out with no target - previously it seeded one anyway with a "no scope configured"
   * placeholder objective, which produced a useless completed work order and looked identical to a
   * silently broken button on every subsequent click). */
  blockedReason?: string;
}

/**
 * Advances one mission's factory pipeline by exactly as much as it can without a human: seeds any
 * newly-needed work orders, starts the next runnable one, and - if it completes without pausing -
 * recurses to pick up whatever that unlocked (new assets/findings may now exist), stopping only
 * once nothing is left to run or a work order needs approval. A work order that comes back
 * "failed"/"cancelled" also stops the chain here rather than immediately retrying something else -
 * that's a signal worth a human's attention, not something to paper over by moving on.
 */
export async function advanceMission(missionId: string, onChunk?: ChunkListener, signal?: AbortSignal): Promise<FactoryAdvanceResult> {
  const mission = await getMission(missionId);
  if (!mission) throw new MissionNotFoundError(missionId);

  const assets = listAssets(missionId);
  const findings = getMissionFindings(missionId);
  let workOrders = listWorkOrders(missionId);

  await seedWorkOrders(mission, assets, findings, workOrders);
  workOrders = listWorkOrders(missionId);

  const settledMission = await maybeAdvanceMissionStatus(mission, computeStage(assets, findings, workOrders));

  const runnable = workOrders
    .filter((wo) => wo.status === "pending" && dependenciesSatisfied(wo))
    .sort((a, b) => b.priority - a.priority || a.createdAt - b.createdAt);
  const next = runnable[0];
  if (!next) {
    const blockedReason =
      assets.length === 0 && !mission.scope?.length
        ? "This mission has no scope configured yet - add at least one in-scope target before starting the factory."
        : undefined;
    return { mission: settledMission, blockedReason };
  }

  const started = await startWorkOrder(next.id, onChunk, signal);
  if (started.status !== "completed") return { mission: settledMission, workOrder: started };

  return advanceMission(missionId, onChunk, signal);
}
