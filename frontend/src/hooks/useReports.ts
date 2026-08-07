import { useCallback, useEffect, useState } from "react";
import { createReport, deleteReport, fetchReports } from "../services/reportsApi";
import type { Report } from "../types/report";

/** Drives the Report Generation feature (see backend/src/services/reportManager.ts): load a
 * project's report history, generate a new one from a set of selected findings (streaming the
 * agent's reply live via `streamingText`), and delete past reports. Project-scoped, mirrors
 * useTools.ts/useScans.ts. */
export function useReports(projectId: string | null) {
  const [reports, setReports] = useState<Report[]>([]);
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [streamingText, setStreamingText] = useState("");
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!projectId) {
      setReports([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      setReports(await fetchReports(projectId));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load reports");
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const generate = useCallback(
    async (title: string, findingIds: string[]): Promise<Report | undefined> => {
      if (!projectId || findingIds.length === 0) return undefined;
      setGenerating(true);
      setError(null);
      setStreamingText("");
      try {
        const report = await createReport(projectId, title, findingIds, (chunk) =>
          setStreamingText((prev) => prev + chunk),
        );
        setReports((prev) => [report, ...prev.filter((r) => r.id !== report.id)]);
        return report;
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to generate the report");
        return undefined;
      } finally {
        setStreamingText("");
        setGenerating(false);
      }
    },
    [projectId],
  );

  const remove = useCallback(
    async (reportId: string) => {
      if (!projectId) return;
      setError(null);
      try {
        await deleteReport(projectId, reportId);
        setReports((prev) => prev.filter((r) => r.id !== reportId));
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to delete the report");
      }
    },
    [projectId],
  );

  return { reports, loading, generating, streamingText, error, refresh, generate, remove };
}
