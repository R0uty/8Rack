import { useState } from "react";
import { Play, Radar, RefreshCw, Square, X } from "lucide-react";
import { useScans } from "../hooks/useScans";
import { Button, GlassPanel, ProgressRing, SectionHeading, Skeleton, StatusPill, type Tone } from "./ui";
import { relativeTime } from "../lib/relativeTime";
import type { ScanRunStatus, ScanStepStatus } from "../types/scanner";

interface ScannerPanelProps {
  missionId: string | null;
}

const STEP_STATUS_LABEL: Record<ScanStepStatus, string> = {
  pending: "Pending",
  running: "Running…",
  completed: "Completed",
  failed: "Failed",
  skipped: "Skipped",
};

const STEP_STATUS_TONE: Record<ScanStepStatus, Tone> = {
  pending: "neutral",
  running: "info",
  completed: "primary",
  failed: "critical",
  skipped: "neutral",
};

const RUN_STATUS_TONE: Record<ScanRunStatus, Tone> = {
  running: "info",
  completed: "primary",
  cancelled: "neutral",
};

/**
 * Scan Profiles: pick a target + a preset chain of exec-tools (see backend/src/scanners/
 * builtins.ts), review the resolved commands once, then run the whole chain with no further
 * per-step approval — deterministic, no agent/LLM in the loop. See backend/src/services/
 * scanRunner.ts and DEVELOPMENT.md's "Security scanners" section for why this differs from the
 * Orchestrator's per-tool-call confirmation.
 */
export function ScannerPanel({ missionId }: ScannerPanelProps) {
  const {
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
  } = useScans(missionId);

  const [profileId, setProfileId] = useState("");
  const [target, setTarget] = useState("");

  const handlePreview = () => {
    if (!profileId || !target.trim()) return;
    runPreview(profileId, target.trim());
  };

  const handleConfirm = () => {
    void runScan();
    setProfileId("");
    setTarget("");
  };

  const showForm = !preview && !running && !run;

  return (
    <section>
      <SectionHeading
        actions={
          <Button variant="secondary" size="sm" icon={RefreshCw} onClick={refresh} disabled={loading}>
            Refresh
          </Button>
        }
      >
        Security Scan
      </SectionHeading>

      {!missionId && <p className="mb-2 text-xs text-muted">Select or create a mission above to run a scan.</p>}
      {error && <p className="mb-2 text-xs text-critical">{error}</p>}

      {loading && profiles.length === 0 && <Skeleton className="h-24 w-full" />}

      {missionId && showForm && (
        <GlassPanel padding="lg" className="flex flex-col gap-3">
          <select
            value={profileId}
            onChange={(e) => setProfileId(e.target.value)}
            className="rounded-lg border border-border bg-surface-2 px-3 py-2 text-sm text-text outline-none focus:border-primary/60 focus-visible:ring-2 focus-visible:ring-primary/60"
          >
            <option value="">Select a scan profile…</option>
            {profiles.map((p) => (
              <option key={p.id} value={p.id}>
                {p.icon} {p.name}
              </option>
            ))}
          </select>
          {profileId && (
            <p className="text-xs text-muted">{profiles.find((p) => p.id === profileId)?.description}</p>
          )}
          <input
            type="text"
            placeholder="Target, e.g. example.com"
            value={target}
            onChange={(e) => setTarget(e.target.value)}
            className="rounded-lg border border-border bg-surface-2 px-3 py-2 text-sm text-text outline-none placeholder:text-muted focus:border-primary/60 focus-visible:ring-2 focus-visible:ring-primary/60"
          />
          <Button
            variant="primary"
            icon={Radar}
            onClick={handlePreview}
            disabled={!profileId || !target.trim() || previewing}
            className="self-start"
          >
            {previewing ? "Resolving…" : "Preview Scan"}
          </Button>
        </GlassPanel>
      )}

      {preview && (
        <GlassPanel padding="lg" className="flex flex-col gap-3">
          <div className="flex items-center gap-2 text-sm font-semibold text-text">
            <span>{preview.profile.icon}</span>
            {preview.profile.name}
            <span className="font-mono text-xs font-normal text-muted">→ {preview.target}</span>
          </div>
          <ol className="flex flex-col gap-2">
            {preview.steps.map((step, i) => (
              <li key={i} className="flex flex-col gap-0.5 rounded-lg border border-border bg-surface-2 px-3 py-2">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs font-medium text-text">
                    {i + 1}. {step.label}
                  </span>
                  {!step.available && <StatusPill tone="warning">unavailable</StatusPill>}
                </div>
                <code className="truncate font-mono text-[11px] text-info" title={step.resolvedCommand}>
                  $ {step.resolvedCommand}
                </code>
              </li>
            ))}
          </ol>
          <div className="flex gap-2">
            <Button variant="primary" icon={Play} onClick={handleConfirm}>
              Confirm & Run All
            </Button>
            <Button variant="ghost" icon={X} onClick={clearPreview}>
              Cancel
            </Button>
          </div>
        </GlassPanel>
      )}

      {run && (
        <GlassPanel padding="lg" className="flex flex-col gap-3">
          <div className="flex items-center justify-between gap-2">
            <div className="text-sm font-semibold text-text">
              {run.profileName} <span className="font-mono text-xs font-normal text-muted">→ {run.target}</span>
            </div>
            <div className="flex items-center gap-2">
              <StatusPill tone={RUN_STATUS_TONE[run.status]} pulse={run.status === "running"}>
                {run.status}
              </StatusPill>
              {run.status === "running" ? (
                <Button variant="danger" size="sm" icon={Square} onClick={cancel}>
                  Cancel
                </Button>
              ) : (
                <Button variant="secondary" size="sm" onClick={reset}>
                  New Scan
                </Button>
              )}
            </div>
          </div>

          <ol className="flex flex-col gap-2">
            {run.steps.map((step, i) => (
              <li key={i} className="flex flex-col gap-0.5 rounded-lg border border-border bg-surface-2 px-3 py-2">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs font-medium text-text">
                    {i + 1}. {step.label}
                  </span>
                  <StatusPill tone={STEP_STATUS_TONE[step.status]} pulse={step.status === "running"}>
                    {step.status === "running" && <ProgressRing size={11} />}
                    {STEP_STATUS_LABEL[step.status]}
                  </StatusPill>
                </div>
                {step.resolvedCommand && (
                  <code className="truncate font-mono text-[11px] text-info" title={step.resolvedCommand}>
                    $ {step.resolvedCommand}
                  </code>
                )}
                {step.error && <p className="text-[11px] text-critical">{step.error}</p>}
              </li>
            ))}
          </ol>

          {liveOutput.length > 0 && (
            <pre className="max-h-56 overflow-auto whitespace-pre-wrap rounded-lg border border-border bg-black/20 px-3 py-2.5 font-mono text-xs">
              {liveOutput.map((chunk, i) => (
                <span key={i} className={chunk.stream === "stderr" ? "text-critical" : "text-text"}>
                  {chunk.data}
                </span>
              ))}
            </pre>
          )}
        </GlassPanel>
      )}

      {scans.length > 0 && (
        <div className="mt-3 flex flex-col gap-1.5">
          <h3 className="text-[11px] font-medium uppercase tracking-wide text-muted">Recent Scans</h3>
          {scans.slice(0, 5).map((s) => (
            <div
              key={s.id}
              className="flex items-center justify-between gap-2 rounded-lg border border-border bg-surface-2 px-3 py-2 text-xs"
            >
              <span className="truncate text-text">
                {s.profileName} <span className="font-mono text-muted">→ {s.target}</span>
              </span>
              <div className="flex shrink-0 items-center gap-2">
                <StatusPill tone={RUN_STATUS_TONE[s.status]}>{s.status}</StatusPill>
                <span className="text-muted">{relativeTime(s.createdAt)}</span>
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
