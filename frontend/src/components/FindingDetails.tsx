import { useEffect, useState } from "react";
import { CheckCircle2, ShieldAlert, Sparkles, XCircle } from "lucide-react";
import { STATUS_TONE, STATUS_VERB } from "./FindingsTimeline";
import { Button, Sheet, StatusDot, StatusPill, type Tone } from "./ui";
import { streamChat } from "../services/api";
import { lookupCves } from "../services/findingsApi";
import { relativeTime } from "../lib/relativeTime";
import type { Finding, FindingSeverity } from "../types/finding";

interface FindingDetailsProps {
  finding: Finding | null;
  /** The already-fetched project findings list, used to compute "Related Findings" client-side -
   * same target, different finding - without a dedicated backend round-trip. */
  findings: Finding[];
  onClose: () => void;
  onUpdate: (id: string, patch: { status: Finding["status"] }) => Promise<Finding>;
  onSelectRelated: (finding: Finding) => void;
  /** Called after a successful CVE lookup so newly-created cve findings show up immediately
   * (they'll already surface under "Related Findings" for free, since they share `target`). */
  onRefresh: () => Promise<void>;
}

const SEVERITY_TONE: Record<FindingSeverity, Tone> = {
  info: "neutral",
  low: "info",
  medium: "warning",
  high: "critical",
  critical: "critical",
};

/** The Vulnerability Validator agent's own description ("Reviews findings, eliminates false
 * positives, and estimates severity") is exactly the "AI Explanation" use case, so it's reused
 * directly rather than adding a dedicated agent. */
const EXPLAIN_AGENT_ID = "vulnerability-validator";

function buildExplainPrompt(f: Finding): string {
  return [
    "Explain the following security finding, assess whether it's likely a true positive, and note anything that would help triage it:",
    `Type: ${f.type}`,
    `Severity: ${f.severity}`,
    `Title: ${f.title}`,
    `Description: ${f.description}`,
    `Target: ${f.target}`,
    `Tool: ${f.tool}`,
    `Confidence: ${Math.round(f.confidence * 100)}%`,
    "Evidence:",
    f.evidence || "(none)",
  ].join("\n");
}

function MetaItem({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-[11px] uppercase tracking-wide text-muted">{label}</div>
      <div className="mt-0.5 text-sm text-text">{value}</div>
    </div>
  );
}

export function FindingDetails({ finding, findings, onClose, onUpdate, onSelectRelated, onRefresh }: FindingDetailsProps) {
  const [busy, setBusy] = useState(false);
  const [explaining, setExplaining] = useState(false);
  const [explanation, setExplanation] = useState("");
  const [explainError, setExplainError] = useState<string | null>(null);
  const [checkingCves, setCheckingCves] = useState(false);
  const [cveError, setCveError] = useState<string | null>(null);
  const [cveFoundCount, setCveFoundCount] = useState<number | null>(null);

  // Reset the AI explanation and CVE-lookup result when a different finding is opened, so stale
  // state from the previous finding doesn't linger.
  useEffect(() => {
    setExplanation("");
    setExplainError(null);
    setCveError(null);
    setCveFoundCount(null);
  }, [finding?.id]);

  const handleStatus = async (status: Finding["status"]) => {
    if (!finding || busy) return;
    setBusy(true);
    try {
      await onUpdate(finding.id, { status });
    } finally {
      setBusy(false);
    }
  };

  const handleExplain = async () => {
    if (!finding || explaining) return;
    setExplaining(true);
    setExplanation("");
    setExplainError(null);
    try {
      await streamChat({ agentId: EXPLAIN_AGENT_ID, messages: [{ role: "user", content: buildExplainPrompt(finding) }] }, (event) => {
        if (event.role === "assistant") setExplanation((prev) => prev + event.content);
      });
    } catch (err) {
      setExplainError(err instanceof Error ? err.message : "Failed to get an explanation");
    } finally {
      setExplaining(false);
    }
  };

  const handleCheckCves = async () => {
    if (!finding || checkingCves) return;
    setCheckingCves(true);
    setCveError(null);
    setCveFoundCount(null);
    try {
      const results = await lookupCves(finding.id);
      setCveFoundCount(results.length);
      await onRefresh();
    } catch (err) {
      setCveError(err instanceof Error ? err.message : "CVE lookup failed");
    } finally {
      setCheckingCves(false);
    }
  };

  const related = finding ? findings.filter((f) => f.id !== finding.id && f.target === finding.target) : [];
  const metadataEntries = finding ? Object.entries(finding.metadata) : [];

  return (
    <Sheet open={finding !== null} onClose={onClose} title={finding?.title ?? "Finding"} width="max-w-lg">
      {finding && (
        <>
          <div className="mb-4 flex flex-wrap items-center gap-2">
            <StatusPill tone={SEVERITY_TONE[finding.severity]} pulse={finding.severity === "critical"}>
              {finding.severity}
            </StatusPill>
            <span className="rounded bg-surface-2 px-1.5 py-0.5 text-[11px] capitalize text-muted">
              {finding.type.replace(/_/g, " ")}
            </span>
            <StatusPill tone={finding.status === "verified" ? "primary" : finding.status === "dismissed" ? "neutral" : "info"}>
              {finding.status}
            </StatusPill>
          </div>

          {finding.description && <p className="mb-4 text-sm text-text">{finding.description}</p>}

          <div className="mb-4 grid grid-cols-2 gap-3">
            <MetaItem label="Target" value={finding.target} />
            <MetaItem label="Source Tool" value={finding.tool} />
            <MetaItem label="Confidence" value={`${Math.round(finding.confidence * 100)}%`} />
            <MetaItem label="Source Count" value={String(finding.sourceCount)} />
            <MetaItem label="First Seen" value={relativeTime(finding.firstSeenAt)} />
            <MetaItem label="Last Seen" value={relativeTime(finding.lastSeenAt)} />
          </div>

          {finding.tags.length > 0 && (
            <div className="mb-4 flex flex-wrap gap-1.5">
              {finding.tags.map((tag) => (
                <span key={tag} className="rounded-full bg-surface-2 px-2 py-0.5 text-[11px] text-muted">
                  {tag}
                </span>
              ))}
            </div>
          )}

          <div className="mb-4 flex gap-2">
            <Button variant="secondary" size="sm" icon={CheckCircle2} onClick={() => handleStatus("verified")} disabled={busy}>
              Mark Verified
            </Button>
            <Button variant="danger" size="sm" icon={XCircle} onClick={() => handleStatus("dismissed")} disabled={busy}>
              Dismiss
            </Button>
          </div>

          {finding.type === "technology" && (
            <div className="mb-4">
              <Button variant="secondary" size="sm" icon={ShieldAlert} onClick={handleCheckCves} disabled={checkingCves}>
                {checkingCves ? "Checking…" : "Check for CVEs"}
              </Button>
              <p className="mt-1.5 text-[11px] text-muted">Queries the public NVD database at nvd.nist.gov.</p>
              {cveError && <p className="mt-1.5 text-xs text-critical">{cveError}</p>}
              {cveFoundCount !== null && !cveError && (
                <p className="mt-1.5 text-xs text-muted">
                  {cveFoundCount === 0 ? "No CVEs found." : `Found ${cveFoundCount} CVE${cveFoundCount === 1 ? "" : "s"} - see Related Findings below.`}
                </p>
              )}
            </div>
          )}

          {metadataEntries.length > 0 && (
            <div className="mb-4">
              <h3 className="mb-1.5 text-xs font-semibold text-muted">Metadata</h3>
              <div className="rounded-lg border border-border bg-surface-2 p-2.5 text-xs">
                {metadataEntries.map(([key, value]) => (
                  <div key={key} className="flex gap-2 py-0.5">
                    <span className="shrink-0 font-mono text-muted">{key}:</span>
                    <span className="truncate text-text">{typeof value === "string" ? value : JSON.stringify(value)}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {finding.evidence && (
            <div className="mb-4">
              <h3 className="mb-1.5 text-xs font-semibold text-muted">Evidence / Raw Output</h3>
              <pre className="max-h-64 overflow-auto whitespace-pre-wrap rounded-lg border border-border bg-surface-2 p-2.5 font-mono text-[11px] text-text">
                {finding.evidence}
              </pre>
            </div>
          )}

          {finding.history.length > 0 && (
            <div className="mb-4">
              <h3 className="mb-1.5 text-xs font-semibold text-muted">Timeline</h3>
              <div className="flex flex-col gap-1.5">
                {[...finding.history]
                  .sort((a, b) => b.at - a.at)
                  .map((entry, i) => (
                    <div key={`${entry.status}-${entry.at}-${i}`} className="flex items-center gap-2 text-xs">
                      <StatusDot tone={STATUS_TONE[entry.status]} />
                      <span className="font-medium text-text">{STATUS_VERB[entry.status]}</span>
                      <span className="text-muted">{relativeTime(entry.at)}</span>
                    </div>
                  ))}
              </div>
            </div>
          )}

          {related.length > 0 && (
            <div className="mb-4">
              <h3 className="mb-1.5 text-xs font-semibold text-muted">Related Findings</h3>
              <div className="flex flex-col gap-1">
                {related.map((r) => (
                  <button
                    key={r.id}
                    type="button"
                    onClick={() => onSelectRelated(r)}
                    className="rounded-lg border border-border bg-surface-2 px-2.5 py-1.5 text-left text-xs text-text transition-colors hover:border-border-strong hover:bg-card-hover"
                  >
                    <span className="mr-1.5 capitalize text-muted">{r.type.replace(/_/g, " ")}</span>
                    {r.title}
                  </button>
                ))}
              </div>
            </div>
          )}

          <div>
            <Button variant="secondary" size="sm" icon={Sparkles} onClick={handleExplain} disabled={explaining}>
              {explaining ? "Explaining…" : "Explain with AI"}
            </Button>
            {explainError && <p className="mt-2 text-xs text-critical">{explainError}</p>}
            {explanation && (
              <div className="mt-2 rounded-lg border border-border bg-surface-2 p-2.5 text-sm text-text">{explanation}</div>
            )}
          </div>
        </>
      )}
    </Sheet>
  );
}
