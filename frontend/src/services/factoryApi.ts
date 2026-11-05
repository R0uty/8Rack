import type { Mission } from "../types/mission";
import type { WorkOrder } from "../types/workOrder";
import { ApiError, apiFetch, readNdjsonStream, throwForErrorResponse } from "./httpClient";

export interface FactoryAdvanceResult {
  mission: Mission;
  /** The work order this call started, if any - undefined means nothing was runnable. */
  workOrder?: WorkOrder;
  /** Set when nothing happened and there's a specific, actionable reason - e.g. no scope
   * configured yet, so the Director correctly refused to seed a Recon work order. */
  blockedReason?: string;
}

interface FactoryStreamLine {
  type: "chunk" | "result" | "error";
  content?: string;
  mission?: Mission;
  workOrder?: WorkOrder;
  blockedReason?: string;
  error?: string;
}

/**
 * Advances one mission's factory pipeline by one call - mirrors orchestratorApi.ts#streamTask's
 * NDJSON-reading pattern exactly: a "chunk" line per token from whichever work order is currently
 * generating, then a single terminal "result" line. Call again (after resolving any pending
 * confirmation via the existing tools API) to continue the chain once it pauses.
 */
export async function advanceFactory(
  missionId: string,
  onChunk: (content: string) => void,
  signal?: AbortSignal,
): Promise<FactoryAdvanceResult> {
  const res = await apiFetch(`/api/missions/${encodeURIComponent(missionId)}/factory/advance`, {
    method: "POST",
    signal,
  });
  if (!res.ok) await throwForErrorResponse(res);

  let result: FactoryAdvanceResult | undefined;
  await readNdjsonStream(res, (line) => {
    let parsed: FactoryStreamLine;
    try {
      parsed = JSON.parse(line) as FactoryStreamLine;
    } catch {
      throw new ApiError("Received an invalid response from the server", 502);
    }
    if (parsed.type === "error") throw new ApiError(parsed.error ?? "Factory advance failed", 502);
    if (parsed.type === "chunk" && parsed.content) onChunk(parsed.content);
    if (parsed.type === "result" && parsed.mission) {
      result = { mission: parsed.mission, workOrder: parsed.workOrder, blockedReason: parsed.blockedReason };
    }
  });

  if (!result) {
    if (signal?.aborted) throw new DOMException("The operation was aborted", "AbortError");
    throw new ApiError("Factory advance stream ended without a result", 502);
  }
  return result;
}
