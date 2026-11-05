import { useCallback, useEffect, useRef, useState } from "react";
import { createReport, deleteReport, fetchReports, updateReportStatus } from "../services/reportsApi";
import type { Report, ReportStatus } from "../types/report";

/** Drives the Report Generation feature (see backend/src/services/reportManager.ts): load a
 * mission's report history, generate a new one from a set of selected findings (streaming the
 * agent's reply live via `streamingText`), and delete past reports. Mission-scoped, mirrors
 * useTools.ts/useScans.ts. */
export function useReports(missionId: string | null) {
  const [reports, setReports] = useState<Report[]>([]);
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [streamingText, setStreamingText] = useState("");
  const [error, setError] = useState<string | null>(null);

  /** Guard against a stale previous-mission response landing after a quick mission switch - see
   * useTools.ts's identical ref for the pattern and why it matters. */
  const missionIdRef = useRef(missionId);
  useEffect(() => {
    missionIdRef.current = missionId;
  }, [missionId]);

  const refresh = useCallback(async () => {
    if (!missionId) {
      setReports([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const data = await fetchReports(missionId);
      if (missionIdRef.current !== missionId) return;
      setReports(data);
    } catch (err) {
      if (missionIdRef.current !== missionId) return;
      setError(err instanceof Error ? err.message : "Failed to load reports");
    } finally {
      if (missionIdRef.current === missionId) setLoading(false);
    }
  }, [missionId]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const generate = useCallback(
    async (title: string, findingIds: string[]): Promise<Report | undefined> => {
      if (!missionId || findingIds.length === 0) return undefined;
      setGenerating(true);
      setError(null);
      setStreamingText("");
      try {
        const report = await createReport(missionId, title, findingIds, (chunk) =>
          setStreamingText((prev) => prev + chunk),
        );
        if (missionIdRef.current !== missionId) return undefined;
        setReports((prev) => [report, ...prev.filter((r) => r.id !== report.id)]);
        return report;
      } catch (err) {
        if (missionIdRef.current !== missionId) return undefined;
        setError(err instanceof Error ? err.message : "Failed to generate the report");
        return undefined;
      } finally {
        setStreamingText("");
        setGenerating(false);
      }
    },
    [missionId],
  );

  const remove = useCallback(
    async (reportId: string) => {
      if (!missionId) return;
      setError(null);
      try {
        await deleteReport(missionId, reportId);
        if (missionIdRef.current === missionId)
          setReports((prev) => prev.filter((r) => r.id !== reportId));
      } catch (err) {
        if (missionIdRef.current === missionId)
          setError(err instanceof Error ? err.message : "Failed to delete the report");
      }
    },
    [missionId],
  );

  const setStatus = useCallback(
    async (reportId: string, status: ReportStatus) => {
      if (!missionId) return;
      setError(null);
      try {
        const updated = await updateReportStatus(missionId, reportId, status);
        if (missionIdRef.current === missionId)
          setReports((prev) => prev.map((r) => (r.id === reportId ? updated : r)));
      } catch (err) {
        if (missionIdRef.current === missionId)
          setError(err instanceof Error ? err.message : "Failed to update the report status");
      }
    },
    [missionId],
  );

  return { reports, loading, generating, streamingText, error, refresh, generate, remove, setStatus };
}
