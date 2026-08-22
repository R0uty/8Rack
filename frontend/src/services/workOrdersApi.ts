import type { WorkOrder, WorkOrderCreateInput } from "../types/workOrder";
import { ApiError, apiFetch, throwForErrorResponse } from "./httpClient";

async function unwrapWorkOrder(res: Response): Promise<WorkOrder> {
  if (!res.ok) await throwForErrorResponse(res);
  const data = (await res.json().catch(() => null)) as { workOrder?: WorkOrder } | null;
  if (!data?.workOrder) throw new ApiError("Received an invalid response from the server", 502);
  return data.workOrder;
}

export async function fetchWorkOrders(missionId: string): Promise<WorkOrder[]> {
  const res = await apiFetch(`/api/missions/${encodeURIComponent(missionId)}/workorders`);
  if (!res.ok) await throwForErrorResponse(res);
  const data = (await res.json().catch(() => null)) as { workOrders?: WorkOrder[] } | null;
  if (!data?.workOrders) throw new ApiError("Received an invalid response from the server", 502);
  return data.workOrders;
}

export async function createWorkOrder(missionId: string, input: WorkOrderCreateInput): Promise<WorkOrder> {
  const res = await apiFetch(`/api/missions/${encodeURIComponent(missionId)}/workorders`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  return unwrapWorkOrder(res);
}

export async function startWorkOrder(missionId: string, workOrderId: string): Promise<WorkOrder> {
  const res = await apiFetch(
    `/api/missions/${encodeURIComponent(missionId)}/workorders/${encodeURIComponent(workOrderId)}/start`,
    { method: "POST" },
  );
  return unwrapWorkOrder(res);
}

export async function refreshWorkOrder(missionId: string, workOrderId: string): Promise<WorkOrder> {
  const res = await apiFetch(
    `/api/missions/${encodeURIComponent(missionId)}/workorders/${encodeURIComponent(workOrderId)}/refresh`,
    { method: "POST" },
  );
  return unwrapWorkOrder(res);
}

export async function cancelWorkOrder(missionId: string, workOrderId: string): Promise<WorkOrder> {
  const res = await apiFetch(
    `/api/missions/${encodeURIComponent(missionId)}/workorders/${encodeURIComponent(workOrderId)}/cancel`,
    { method: "POST" },
  );
  return unwrapWorkOrder(res);
}
