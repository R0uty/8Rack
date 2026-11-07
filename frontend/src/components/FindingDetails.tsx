import { useEffect, useState } from "react";
import { CheckCircle2, ShieldAlert, Sparkles } from "lucide-react";
import { Button, Sheet, StatusDot, StatusPill, type Tone } from "./ui";
import { streamChat } from "../services/chatApi";
import { lookupCves } from "../services/findingsApi";
import { FINDING_STATUSES, STATUS_TONE, STATUS_VERB } from "../lib/findingStatus";
import { relativeTime } from "../lib/relativeTime";
import { cn } from "../lib/cn";
import type { EvidenceType, Finding, FindingPatchInput, FindingSeverity, FindingStatus } from "../types/finding";

interface FindingDetailsProps {
  finding: Finding | null;
  /** The already-fetched mission findings list, used to compute "Related Findings" client-side -
   * same target, different finding - without a dedicated backend round-trip. */
  findings: Finding[];
  onClose: () => void;
  onUpdate: (id: string, patch: FindingPatchInput) => Promise<Finding>;
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

const EVIDENCE_TYPE_LABEL: Record<EvidenceType, string> = {
  http_request: "HTTP Request",
  http_response: "HTTP Response",
  terminal_output: "Terminal Output",
  tool_result: "Tool Result",
  agent_reasoning: "Agent Reasoning",
  note: "Note",
};

const TEXT_INPUT_CLASS =
  "w-full rounded-lg border border-border bg-surface-2 px-2.5 py-1.5 text-xs text-text outline-none placeholder:text-muted focus:border-primary/60 focus-visible:ring-2 focus-visible:ring-primary/60";

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
    ...(f.parameter ? [`Parameter: ${f.parameter}`] : []),
    "Evidence:",
    f.evidence.length > 0 ? f.evidence.map((e) => `[${e.type}] ${e.content}`).join("\n---\n") : "(none)",
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
  const [statusError, setStatusError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [explaining, setExplaining] = useState(false);
  const [explanation, setExplanation] = useState("");
  const [explainError, setExplainError] = useState<string | null>(null);
  const [checkingCves, setCheckingCves] = useState(false);
  const [cveError, setCveError] = useState<string | null>(null);
  const [cveFoundCount, setCveFoundCount] = useState<number | null>(null);
  const [parameter, setParameter] = useState("");
  const [impact, setImpact] = useState("");
  const [reproductionSteps, setReproductionSteps] = useState("");
  const [detailsBusy, setDetailsBusy] = useState(false);
  const [detailsError, setDetailsError] = useState<string | null>(null);

  // Reset the AI explanation, CVE-lookup result, and the editable detail fields when a different
  // finding is opened, so stale state from the previous finding doesn't linger.
  useEffect(() => {
    setExplanation("");
    setExplainError(null);
    setCveError(null);
    setCveFoundCount(null);
    setParameter(finding?.parameter ?? "");
    setImpact(finding?.impact ?? "");
    setReproductionSteps(finding?.reproductionSteps ?? "");
    setDetailsError(null);
  }, [finding?.id, finding?.parameter, finding?.impact, finding?.reproductionSteps]);

  const detailsDirty =
    !!finding &&
    (parameter !== (finding.parameter ?? "") ||
      impact !== (finding.impact ?? "") ||
      reproductionSteps !== (finding.reproductionSteps ?? ""));

  const handleStatus = async (status: FindingStatus) => {
    if (!finding || busy) return;
    setBusy(true);
    setStatusError(null);
    try {
      await onUpdate(finding.id, { status });
    } catch (err) {
      setStatusError(err instanceof Error ? err.message : "Failed to update the status");
    } finally {
      setBusy(false);
    }
  };

  const handleSaveDetails = async () => {
    if (!finding || detailsBusy || !detailsDirty) return;
    setDetailsBusy(true);
    setDetailsError(null);
    try {
      await onUpdate(finding.id, { parameter, impact, reproductionSteps });
    } catch (err) {
      setDetailsError(err instanceof Error ? err.message : "Failed to save details");
    } finally {
      setDetailsBusy(false);
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
            <StatusPill tone={STATUS_TONE[finding.status]}>{STATUS_VERB[finding.status]}</StatusPill>
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

          <div className="mb-4">
            <span className="mb-1.5 block text-[11px] font-medium text-muted">Status</span>
            <div className="flex flex-wrap gap-1.5">
              {FINDING_STATUSES.map((s) => (
                <Button
                  key={s}
                  variant={finding.status === s ? "primary" : "secondary"}
                  size="sm"
                  icon={s === "confirmed" ? CheckCircle2 : undefined}
                  onClick={() => handleStatus(s)}
                  disabled={busy || finding.status === s}
                >
                  {STATUS_VERB[s]}
                </Button>
              ))}
            </div>
            {statusError && <p className="mt-1.5 text-xs text-critical">{statusError}</p>}
          </div>

          <div className="mb-4">
            <h3 className="mb-1.5 text-xs font-semibold text-muted">Details</h3>
            <div className="flex flex-col gap-2.5 rounded-lg border border-border bg-surface-2 p-2.5">
              <label className="block">
                <span className="mb-1 block text-[11px] text-muted">Parameter</span>
                <input
                  type="text"
                  value={parameter}
                  onChange={(e) => setParameter(e.target.value)}
                  placeholder="e.g. id, redirect_url"
                  className={TEXT_INPUT_CLASS}
                />
              </label>
              <label className="block">
                <span className="mb-1 block text-[11px] text-muted">Impact</span>
                <textarea
                  value={impact}
                  onChange={(e) => setImpact(e.target.value)}
                  rows={2}
                  placeholder="What happens if this is exploited?"
                  className={cn(TEXT_INPUT_CLASS, "resize-none")}
                />
              </label>
              <label className="block">
                <span className="mb-1 block text-[11px] text-muted">Reproduction Steps</span>
                <textarea
                  value={reproductionSteps}
                  onChange={(e) => setReproductionSteps(e.target.value)}
                  rows={3}
                  placeholder="1. ...&#10;2. ..."
                  className={cn(TEXT_INPUT_CLASS, "resize-none")}
                />
              </label>
              <Button variant="secondary" size="sm" onClick={handleSaveDetails} disabled={detailsBusy || !detailsDirty}>
                {detailsBusy ? "Saving…" : "Save details"}
              </Button>
              {detailsError && <p className="text-xs text-critical">{detailsError}</p>}
            </div>
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

          {finding.evidence.length > 0 && (
            <div className="mb-4">
              <h3 className="mb-1.5 text-xs font-semibold text-muted">Evidence</h3>
              <div className="flex flex-col gap-2">
                {[...finding.evidence].reverse().map((item, i) => (
                  <div key={i} className="rounded-lg border border-border bg-surface-2 p-2.5">
                    <div className="mb-1 flex items-center justify-between">
                      <span className="text-[11px] font-medium text-muted">{EVIDENCE_TYPE_LABEL[item.type]}</span>
                      <span className="text-[11px] text-muted">{relativeTime(item.createdAt)}</span>
                    </div>
                    <pre className="max-h-64 overflow-auto whitespace-pre-wrap font-mono text-[11px] text-text">
                      {item.content}
                    </pre>
                  </div>
                ))}
              </div>
            </div>
          )}

          {(finding.relatedAgents.length > 0 || finding.executionIds.length > 0) && (
            <div className="mb-4 grid grid-cols-2 gap-3">
              {finding.relatedAgents.length > 0 && (
                <div>
                  <div className="mb-1 text-[11px] uppercase tracking-wide text-muted">Related Agents</div>
                  <div className="flex flex-wrap gap-1">
                    {finding.relatedAgents.map((a) => (
                      <span key={a} className="rounded bg-surface-2 px-1.5 py-0.5 text-[11px] text-muted">
                        {a}
                      </span>
                    ))}
                  </div>
                </div>
              )}
              {finding.executionIds.length > 0 && (
                <div>
                  <div className="mb-1 text-[11px] uppercase tracking-wide text-muted">
                    Related Executions ({finding.executionIds.length})
                  </div>
                  <div className="text-[11px] text-muted">
                    {finding.executionIds.length} tool execution{finding.executionIds.length === 1 ? "" : "s"}
                  </div>
                </div>
              )}
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
