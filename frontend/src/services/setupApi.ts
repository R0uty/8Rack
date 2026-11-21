import type { SetupStatus } from "../types/setup";
import { ApiError, apiFetch, throwForErrorResponse } from "./httpClient";

export async function fetchSetupStatus(): Promise<SetupStatus> {
  const res = await apiFetch("/api/setup");
  if (!res.ok) await throwForErrorResponse(res);
  const data = (await res.json().catch(() => null)) as { setup?: SetupStatus } | null;
  if (!data?.setup) throw new ApiError("Received an invalid response from the server", 502);
  return data.setup;
}
