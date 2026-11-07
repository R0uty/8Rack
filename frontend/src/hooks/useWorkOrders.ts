import { useCallback, useEffect, useRef, useState } from "react";
import { cancelWorkOrder, createWorkOrder, fetchWorkOrders, refreshWorkOrder, startWorkOrder } from "../services/workOrdersApi";
import type { WorkOrder, WorkOrderCreateInput } from "../types/workOrder";

/** Work orders are mission-scoped, like useFindings' findings - pass null when no mission is
 * selected yet (work orders stay empty, nothing is fetched). */
export function useWorkOrders(missionId: string | null) {
  const [workOrders, setWorkOrders] = useState<WorkOrder[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  /** Guard against a stale previous-mission response landing after a quick mission switch - see
   * useTools.ts's identical ref for the pattern and why it matters. */
  const missionIdRef = useRef(missionId);
  useEffect(() => {
    missionIdRef.current = missionId;
  }, [missionId]);

  const refresh = useCallback(async () => {
    if (!missionId) {
      setWorkOrders([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const data = await fetchWorkOrders(missionId);
      if (missionIdRef.current !== missionId) return;
      setWorkOrders(data);
    } catch (err) {
      if (missionIdRef.current !== missionId) return;
      setError(err instanceof Error ? err.message : "Failed to load work orders");
    } finally {
      if (missionIdRef.current === missionId) setLoading(false);
    }
  }, [missionId]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const create = useCallback(
    async (input: WorkOrderCreateInput) => {
      if (!missionId) throw new Error("No mission selected");
      const workOrder = await createWorkOrder(missionId, input);
      await refresh();
      return workOrder;
    },
    [missionId, refresh],
  );

  const start = useCallback(
    async (id: string) => {
      if (!missionId) throw new Error("No mission selected");
      const workOrder = await startWorkOrder(missionId, id);
      await refresh();
      return workOrder;
    },
    [missionId, refresh],
  );

  const cancel = useCallback(
    async (id: string) => {
      if (!missionId) throw new Error("No mission selected");
      const workOrder = await cancelWorkOrder(missionId, id);
      await refresh();
      return workOrder;
    },
    [missionId, refresh],
  );

  /** Re-syncs one work order's status from its underlying OrchestratorTask - the list endpoint
   * returns whatever's currently cached, which can go stale (e.g. a task that later hit
   * max_time_reached) until something explicitly asks it to re-check. */
  const refreshOne = useCallback(
    async (id: string) => {
      if (!missionId) throw new Error("No mission selected");
      const workOrder = await refreshWorkOrder(missionId, id);
      if (missionIdRef.current === missionId) setWorkOrders((prev) => prev.map((w) => (w.id === id ? workOrder : w)));
      return workOrder;
    },
    [missionId],
  );

  return { workOrders, loading, error, refresh, create, start, cancel, refreshOne };
}
