import { useEffect, useState, type ReactNode } from "react";
import type { MissionStatus, Mission } from "../types/mission";
import { Button, Sheet } from "./ui";
import { cn } from "../lib/cn";

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
  status: MissionStatus | "";
  scope: string;
  outOfScope: string;
  rules: string;
}

const EMPTY_FORM: FormState = {
  name: "",
  notes: "",
  description: "",
  status: "",
  scope: "",
  outOfScope: "",
  rules: "",
};

const STATUS_OPTIONS: MissionStatus[] = [
  "draft",
  "ready",
  "recon",
  "investigating",
  "validating",
  "reporting",
  "review",
  "completed",
  "paused",
  "cancelled",
];

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
    status: mission.status ?? "",
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

  useEffect(() => {
    if (!open) return;
    setForm(mission ? formFromMission(mission) : EMPTY_FORM);
    setError(null);
    setConfirmingDelete(false);
  }, [open, mission]);

  const handleSave = async () => {
    if (!form.name.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      await onSave(mission?.id ?? null, {
        name: form.name.trim(),
        notes: form.notes,
        description: form.description.trim(),
        status: form.status || undefined,
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
        <Field label="Status">
          <select
            value={form.status}
            disabled={busy}
            onChange={(e) => setForm((f) => ({ ...f, status: e.target.value as MissionStatus | "" }))}
            className={TEXT_INPUT_CLASS}
          >
            <option value="">Unset</option>
            {STATUS_OPTIONS.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </Field>
      )}

      <Field
        label="Scope"
        hint='One target per line - domains, "*.sub.example.com" wildcards, bare IPs, CIDR ranges, or URLs. Tool executions against a target outside this list are automatically blocked.'
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

      {error && <p className="mb-3 text-xs text-critical">{error}</p>}

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
