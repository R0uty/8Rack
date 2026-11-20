import { useEffect, useMemo, useState, type ReactNode } from "react";
import { CheckCircle2, Eye, Pause, Play, RotateCcw } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { MissionStatus, Mission } from "../types/mission";
import { Button, Sheet, Notice, StatusPill } from "./ui";
import { cn } from "../lib/cn";
import { classifyScopeText } from "../lib/scopeLines";

interface MissionEditorProps {
  open: boolean;
  /** The mission being edited, or null to create a new one. */
  mission: Mission | null;
  onSave: (id: string | null, patch: Partial<Mission>) => Promise<unknown>;
  onDelete: (id: string) => Promise<unknown>;
  onClose: () => void;
}

interface FormState {
  name: string;
  notes: string;
  description: string;
  scope: string;
  outOfScope: string;
  rules: string;
}

const EMPTY_FORM: FormState = {
  name: "",
  notes: "",
  description: "",
  scope: "",
  outOfScope: "",
  rules: "",
};

interface StatusAction {
  label: string;
  to: MissionStatus;
  icon: LucideIcon;
}

const PAUSE: StatusAction = { label: "Pause", to: "paused", icon: Pause };
const RESUME: StatusAction = { label: "Resume", to: "ready", icon: Play };
const REVIEW: StatusAction = { label: "Send to review", to: "review", icon: Eye };
const COMPLETE: StatusAction = { label: "Complete", to: "completed", icon: CheckCircle2 };
const REOPEN: StatusAction = { label: "Reopen", to: "ready", icon: RotateCcw };

/** The stages from draft to reporting belong to the Factory Director (it moves a mission forward as
 * work lands), so a human only gets the moves the Director never makes. Resume and Reopen go back to
 * "ready" and the Director catches the stage up on its next advance. */
function statusActions(status: MissionStatus | undefined): StatusAction[] {
  switch (status) {
    case "paused":
      return [RESUME, COMPLETE];
    case "review":
      return [COMPLETE, REOPEN];
    case "completed":
    case "cancelled":
      return [REOPEN];
    default:
      return [PAUSE, REVIEW, COMPLETE];
  }
}

function ScopeCheck({ text, label }: { text: string; label: string }) {
  const lines = useMemo(() => classifyScopeText(text), [text]);
  if (lines.length === 0) return null;
  return (
    <ul aria-label={`How ${label} is read`} className="-mt-2 mb-4 flex flex-col gap-0.5 text-[11px]">
      {lines.map((l, i) => (
        <li key={`${i}-${l.line}`} className="flex flex-wrap gap-x-1.5">
          <span className="font-mono text-text">{l.line}</span>
          <span className={l.kind === "unrecognized" ? "text-critical" : "text-muted"}>→ {l.meaning}</span>
          {l.warning && <span className={l.kind === "unrecognized" ? "text-critical" : "text-warning"}>{l.warning}</span>}
        </li>
      ))}
    </ul>
  );
}

function linesToList(value: string): string[] {
  return value
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

function formFromMission(mission: Mission): FormState {
  return {
    name: mission.name,
    notes: mission.notes,
    description: mission.description ?? "",
    scope: (mission.scope ?? []).join("\n"),
    outOfScope: (mission.outOfScope ?? []).join("\n"),
    rules: mission.rules ?? "",
  };
}

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="mb-4">
      {/* Hint deliberately lives outside the <label> - an implicit (wrapping) label's accessible
       * name is computed from all its text content, so a hint inside it would get concatenated
       * onto the field's name (breaking both screen readers announcing just "Scope" and any test
       * querying by label text). */}
      <label className="block">
        <span className="mb-1.5 block text-xs font-medium text-muted">{label}</span>
        {children}
      </label>
      {hint && <p className="mt-1 text-[11px] text-muted">{hint}</p>}
    </div>
  );
}

const TEXT_INPUT_CLASS =
  "w-full rounded-lg border border-border bg-surface-2 px-3 py-2 text-sm text-text outline-none placeholder:text-muted focus:border-primary/60 focus-visible:ring-2 focus-visible:ring-primary/60";

/** Creates or edits a mission - scope belongs here from the start, since nothing can run without it. */
export function MissionEditor({ open, mission, onSave, onDelete, onClose }: MissionEditorProps) {
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [status, setStatus] = useState<MissionStatus | undefined>(undefined);

  // Reset on open or on a different mission - not on every new `mission` object, since a status
  // move saves and hands back an updated one, and that must not wipe edits typed so far.
  const missionId = mission?.id;
  useEffect(() => {
    if (!open) return;
    setForm(mission ? formFromMission(mission) : EMPTY_FORM);
    setStatus(mission?.status);
    setError(null);
    setConfirmingDelete(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, missionId]);

  const handleSave = async () => {
    if (!form.name.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      await onSave(mission?.id ?? null, {
        name: form.name.trim(),
        notes: form.notes,
        description: form.description.trim(),
        scope: linesToList(form.scope),
        outOfScope: linesToList(form.outOfScope),
        rules: form.rules.trim(),
      });
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save mission");
    } finally {
      setBusy(false);
    }
  };

  // Status moves apply at once - they are decisions about the mission, not edits to the form.
  const handleStatus = async (to: MissionStatus) => {
    if (!mission || busy) return;
    setBusy(true);
    setError(null);
    try {
      await onSave(mission.id, { status: to });
      setStatus(to);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to change the status");
    } finally {
      setBusy(false);
    }
  };

  const handleDelete = async () => {
    if (!mission || busy) return;
    setBusy(true);
    setError(null);
    try {
      await onDelete(mission.id);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete mission");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet open={open} onClose={onClose} title={mission ? `Edit ${mission.name}` : "New mission"} width="max-w-lg">
      <Field label="Name">
        <input
          type="text"
          value={form.name}
          disabled={busy}
          onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
          className={TEXT_INPUT_CLASS}
        />
      </Field>

      <Field label="Notes" hint="Just for you - agents never see these.">
        <textarea
          value={form.notes}
          disabled={busy}
          rows={2}
          onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))}
          className={cn(TEXT_INPUT_CLASS, "resize-none")}
        />
      </Field>

      <Field label="Description" hint="Given to every agent working this mission.">
        <textarea
          placeholder="What is this engagement, at a glance?"
          value={form.description}
          disabled={busy}
          rows={2}
          onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
          className={cn(TEXT_INPUT_CLASS, "resize-none")}
        />
      </Field>

      {mission && (
        <div className="mb-4">
          <span className="mb-1.5 block text-xs font-medium text-muted">Status</span>
          <div className="flex flex-wrap items-center gap-1.5">
            <StatusPill tone="neutral">
              {status ?? "not started"}
            </StatusPill>
            {statusActions(status).map((a) => (
              <Button key={a.label} variant="secondary" size="sm" icon={a.icon} disabled={busy} onClick={() => handleStatus(a.to)}>
                {a.label}
              </Button>
            ))}
          </div>
        </div>
      )}

      <Field
        label="Scope"
        hint='One target per line - domains, "*.sub.example.com" wildcards, bare IPs, CIDR ranges, or URLs. Tool executions against a target outside this list are automatically blocked. Ports and paths are not enforced yet.'
      >
        <textarea
          placeholder={"example.com\n*.example.com\n10.0.0.0/24"}
          value={form.scope}
          disabled={busy}
          rows={3}
          onChange={(e) => setForm((f) => ({ ...f, scope: e.target.value }))}
          className={cn(TEXT_INPUT_CLASS, "resize-none font-mono")}
        />
      </Field>
      <ScopeCheck text={form.scope} label="Scope" />

      <Field label="Out of scope" hint="Same format as Scope - checked first, always wins over a broader Scope match.">
        <textarea
          placeholder="staging.example.com"
          value={form.outOfScope}
          disabled={busy}
          rows={2}
          onChange={(e) => setForm((f) => ({ ...f, outOfScope: e.target.value }))}
          className={cn(TEXT_INPUT_CLASS, "resize-none font-mono")}
        />
      </Field>
      <ScopeCheck text={form.outOfScope} label="Out of scope" />

      <Field label="Rules of engagement">
        <textarea
          placeholder="e.g. no automated DoS testing, business hours only"
          value={form.rules}
          disabled={busy}
          rows={2}
          onChange={(e) => setForm((f) => ({ ...f, rules: e.target.value }))}
          className={cn(TEXT_INPUT_CLASS, "resize-none")}
        />
      </Field>

      {error && <Notice className="mb-3">{error}</Notice>}

      <div className="flex flex-wrap items-center justify-between gap-2">
        <Button variant="primary" size="sm" onClick={handleSave} disabled={busy || !form.name.trim()}>
          {busy ? "Saving…" : mission ? "Save changes" : "Create mission"}
        </Button>
        {mission &&
          (confirmingDelete ? (
            <span className="flex items-center gap-1.5">
              <Button variant="danger" size="sm" onClick={handleDelete} disabled={busy}>
                Delete permanently
              </Button>
              <Button variant="secondary" size="sm" onClick={() => setConfirmingDelete(false)} disabled={busy}>
                Keep
              </Button>
            </span>
          ) : (
            <Button variant="ghost" size="sm" onClick={() => setConfirmingDelete(true)} disabled={busy}>
              Delete mission
            </Button>
          ))}
      </div>
    </Sheet>
  );
}
