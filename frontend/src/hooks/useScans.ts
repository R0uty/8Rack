import { useCallback, useEffect, useRef, useState } from "react";
import { cancelScan, createScan, fetchScanProfiles, fetchScans, previewScan } from "../services/scannersApi";
import type { ScanPreview, ScanProfile, ScanRun } from "../types/scanner";

export interface LiveScanOutputChunk {
  stream: "stdout" | "stderr";
  data: string;
}

/**
 * Drives the Scan Profiles feature (see backend/src/services/scanRunner.ts): load the built-in
 * profile roster + this mission's scan history, preview a profile resolved against a target, then
 * run it end to end with live step/output progress. One confirmation (the preview step) covers the
 * whole chained run — see DEVELOPMENT.md's "Security scanners" section for why, unlike the
 * Orchestrator's per-tool-call approval. Mission-scoped, mirrors useTools.ts's conventions.
 */
export function useScans(missionId: string | null) {
  const [profiles, setProfiles] = useState<ScanProfile[]>([]);
  const [scans, setScans] = useState<ScanRun[]>([]);
  const [run, setRun] = useState<ScanRun | null>(null);
  const [liveOutput, setLiveOutput] = useState<LiveScanOutputChunk[]>([]);
  const [preview, setPreview] = useState<ScanPreview | null>(null);
  const [loading, setLoading] = useState(true);
  const [previewing, setPreviewing] = useState(false);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const nextStepIndexRef = useRef(0);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [profileList, scanList] = await Promise.all([
        fetchScanProfiles(),
        missionId ? fetchScans(missionId) : Promise.resolve([]),
      ]);
      setProfiles(profileList);
      setScans(scanList);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load scanners");
    } finally {
      setLoading(false);
    }
  }, [missionId]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const runPreview = useCallback(
    async (profileId: string, target: string) => {
      if (!missionId) return;
      setPreviewing(true);
      setError(null);
      try {
        setPreview(await previewScan(missionId, profileId, target));
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to preview the scan");
        setPreview(null);
      } finally {
        setPreviewing(false);
      }
    },
    [missionId],
  );

  const clearPreview = useCallback(() => setPreview(null), []);

  const runScan = useCallback(async () => {
    if (!missionId || !preview) return;
    const { profile, target } = preview;

    setRunning(true);
    setError(null);
    setRun(null);
    setLiveOutput([]);
    setPreview(null);
    nextStepIndexRef.current = 0;

    try {
      const finished = await createScan(missionId, profile.id, target, (event) => {
        if (event.type === "scan") {
          setRun(event.scan);
          nextStepIndexRef.current = 0;
          return;
        }
        if (event.type === "step") {
          if (event.step.status === "running") setLiveOutput([]);
          const idx = nextStepIndexRef.current;
          setRun((prev) => {
            if (!prev) return prev;
            if (idx >= prev.steps.length) return prev;
            const steps = [...prev.steps];
            steps[idx] = event.step;
            return { ...prev, steps };
          });
          if (event.step.status !== "running") nextStepIndexRef.current += 1;
          return;
        }
        setLiveOutput((prev) => [...prev, { stream: event.stream, data: event.data }]);
      });
      setRun(finished);
      setScans((prev) => [finished, ...prev.filter((s) => s.id !== finished.id)]);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Scan failed");
    } finally {
      setRunning(false);
    }
  }, [missionId, preview]);

  /** Tells the backend to stop scheduling further steps — the in-flight `createScan` request stays
   * open and keeps streaming (skipped steps, then the final cancelled ScanRun), so this doesn't
   * touch local state itself; `runScan`'s own stream handling settles it. */
  const cancel = useCallback(async () => {
    if (!missionId || !run) return;
    try {
      await cancelScan(missionId, run.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to cancel the scan");
    }
  }, [missionId, run]);

  const reset = useCallback(() => {
    setRun(null);
    setLiveOutput([]);
    setPreview(null);
    setError(null);
  }, []);

  return {
    profiles,
    scans,
    run,
    liveOutput,
    preview,
    loading,
    previewing,
    running,
    error,
    refresh,
    runPreview,
    clearPreview,
    runScan,
    cancel,
    reset,
  };
}
