import { NoMission } from "./NoMission";
import { ReportsPanel } from "./ReportsPanel";
import { useReports } from "../hooks/useReports";
import { useRefreshOnActivate } from "../hooks/useRefreshOnActivate";
import type { Mission } from "../types/mission";

/** A mission's generated reports and where each one stands. Generation itself happens from Findings
 * (select findings there first) or the Factory's report nudge. */
export function ReportsView({ mission, active = true }: { mission: Mission | null; active?: boolean }) {
  const { reports, loading, error, refresh, remove, setStatus } = useReports(mission?.id ?? null);
  useRefreshOnActivate(active, refresh);

  if (!mission) return <NoMission />;
  return <ReportsPanel reports={reports} loading={loading} error={error} onDelete={remove} onChangeStatus={setStatus} />;
}
