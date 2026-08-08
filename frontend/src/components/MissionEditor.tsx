import { useEffect, useState, type ReactNode } from "react";
import type { MissionStatus, Project } from "../types/project";
import { Button, Sheet } from "./ui";
import { cn } from "../lib/cn";

interface MissionEditorProps {
  open: boolean;
  /** The project being edited - MissionEditor is edit-only (creation stays ProjectPanel's quick
   * name+notes form), so this is never null while open. */
  project: Project | null;
  onSave: (id: string, patch: Partial<Project>) => Promise<unknown>;
  onClose: () => void;
}

interface FormState {
  name: string;
  notes: string;
  description: string;
  status: MissionStatus | "";
  startDate: string;
  scope: string;
  outOfScope: string;
  rules: string;
}

const EMPTY_FORM: FormState = {
  name: "",
  notes: "",
  description: "",
  status: "",
  startDate: "",
  scope: "",
  outOfScope: "",
  rules: "",
};

const STATUS_OPTIONS: MissionStatus[] = ["planning", "active", "paused", "completed"];

/** epoch ms -> "YYYY-MM-DD" for the date input's value, in the local timezone (not UTC) so the
 * displayed date matches what the user picked when it was originally saved. */
function toDateInputValue(epochMs: number | undefined): string {
  if (!epochMs) return "";
  const d = new Date(epochMs);
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function fromDateInputValue(value: string): number | undefined {
  if (!value) return undefined;
  const ms = new Date(value).getTime();
  return Number.isNaN(ms) ? undefined : ms;
}

function linesToList(value: string): string[] {
  return value
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

function formFromProject(project: Project): FormState {
  return {
    name: project.name,
    notes: project.notes,
    description: project.description ?? "",
    status: project.status ?? "",
    startDate: toDateInputValue(project.startDate),
    scope: (project.scope ?? []).join("\n"),
    outOfScope: (project.outOfScope ?? []).join("\n"),
    rules: project.rules ?? "",
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

/**
 * Edits a mission's structured fields (see types/project.ts) - opened from ProjectPanel's per-card
 * Edit affordance. Quick create (name + notes only) stays in ProjectPanel itself; this is
 * deliberately edit-only so a brand-new mission doesn't have to be filled out in full before it
 * even has an id to key everything else (findings, executions, tasks) against.
 */
export function MissionEditor({ open, project, onSave, onClose }: MissionEditorProps) {
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setForm(project ? formFromProject(project) : EMPTY_FORM);
    setError(null);
  }, [open, project]);

  const handleSave = async () => {
    if (!project || !form.name.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      await onSave(project.id, {
        name: form.name.trim(),
        notes: form.notes,
        description: form.description.trim(),
        status: form.status || undefined,
        startDate: fromDateInputValue(form.startDate),
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

  return (
    <Sheet open={open} onClose={onClose} title={project ? `Edit ${project.name}` : "Edit Mission"} width="max-w-lg">
      <Field label="Name">
        <input
          type="text"
          value={form.name}
          disabled={busy}
          onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
          className={TEXT_INPUT_CLASS}
        />
      </Field>

      <Field label="Notes">
        <textarea
          value={form.notes}
          disabled={busy}
          rows={2}
          onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))}
          className={cn(TEXT_INPUT_CLASS, "resize-none")}
        />
      </Field>

      <Field label="Description">
        <textarea
          placeholder="What is this engagement, at a glance?"
          value={form.description}
          disabled={busy}
          rows={2}
          onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
          className={cn(TEXT_INPUT_CLASS, "resize-none")}
        />
      </Field>

      <div className="mb-4 flex gap-3">
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
        <Field label="Start date">
          <input
            type="date"
            value={form.startDate}
            disabled={busy}
            onChange={(e) => setForm((f) => ({ ...f, startDate: e.target.value }))}
            className={TEXT_INPUT_CLASS}
          />
        </Field>
      </div>

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

      <Button variant="primary" size="sm" onClick={handleSave} disabled={busy || !form.name.trim()}>
        {busy ? "Saving…" : "Save changes"}
      </Button>
    </Sheet>
  );
}
