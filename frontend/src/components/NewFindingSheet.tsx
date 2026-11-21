import { useState } from "react";
import { Button, Notice, SELECT_CLASS, Sheet } from "./ui";
import { FINDING_SEVERITIES } from "../types/finding";
import type { FindingCreateInput, FindingSeverity, FindingType } from "../types/finding";

/** Display order - the likeliest kinds of hand-added finding first. */
const TYPES: FindingType[] = [
  "potential_vulnerability",
  "confirmed_vulnerability",
  "endpoint",
  "directory",
  "interesting_file",
  "credential",
  "cookie",
  "header",
  "api",
  "technology",
  "service",
  "port",
  "domain",
  "subdomain",
  "information",
  "cve",
];
const SEVERITIES = FINDING_SEVERITIES;

const INPUT_CLASS =
  "w-full rounded-lg border border-border bg-surface-2 px-2.5 py-1.5 text-xs text-text outline-none placeholder:text-muted focus:border-primary/60 focus-visible:ring-2 focus-visible:ring-primary/60";

interface NewFindingSheetProps {
  open: boolean;
  onClose: () => void;
  onCreate: (input: FindingCreateInput) => Promise<unknown>;
}

/** Records something a human found themselves - the API always allowed it, the UI had no button. */
export function NewFindingSheet({ open, onClose, onCreate }: NewFindingSheetProps) {
  const [type, setType] = useState<FindingType>("potential_vulnerability");
  const [severity, setSeverity] = useState<FindingSeverity>("medium");
  const [title, setTitle] = useState("");
  const [target, setTarget] = useState("");
  const [value, setValue] = useState("");
  const [description, setDescription] = useState("");
  const [evidence, setEvidence] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const valid = title.trim() && target.trim();

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!valid || saving) return;
    setSaving(true);
    setError(null);
    try {
      await onCreate({
        type,
        severity,
        title: title.trim(),
        target: target.trim(),
        // The dedup key; when there's nothing more specific, the target itself.
        value: value.trim() || target.trim(),
        description: description.trim(),
        evidence: evidence.trim() || undefined,
        tool: "manual",
      });
      setTitle("");
      setTarget("");
      setValue("");
      setDescription("");
      setEvidence("");
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to add the finding");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Sheet open={open} onClose={onClose} title="Add finding" width="max-w-md">
      <form onSubmit={submit} className="flex flex-col gap-3">
        <label className="flex flex-col gap-1 text-xs text-muted">
          Title
          <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Reflected XSS in search" className={INPUT_CLASS} />
        </label>
        <div className="grid grid-cols-2 gap-2">
          <label className="flex flex-col gap-1 text-xs text-muted">
            Type
            <select value={type} onChange={(e) => setType(e.target.value as FindingType)} className={SELECT_CLASS}>
              {TYPES.map((t) => (
                <option key={t} value={t}>
                  {t.replace(/_/g, " ")}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-xs text-muted">
            Severity
            <select value={severity} onChange={(e) => setSeverity(e.target.value as FindingSeverity)} className={SELECT_CLASS}>
              {SEVERITIES.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </label>
        </div>
        <label className="flex flex-col gap-1 text-xs text-muted">
          Target
          <input value={target} onChange={(e) => setTarget(e.target.value)} placeholder="example.com" className={`${INPUT_CLASS} font-mono`} />
        </label>
        <label className="flex flex-col gap-1 text-xs text-muted">
          Where exactly (optional)
          <input value={value} onChange={(e) => setValue(e.target.value)} placeholder="e.g. /search?q" className={`${INPUT_CLASS} font-mono`} />
        </label>
        <label className="flex flex-col gap-1 text-xs text-muted">
          Description
          <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={3} className={INPUT_CLASS} />
        </label>
        <label className="flex flex-col gap-1 text-xs text-muted">
          Evidence (optional)
          <textarea value={evidence} onChange={(e) => setEvidence(e.target.value)} rows={3} placeholder="Request/response, a screenshot path, steps…" className={`${INPUT_CLASS} font-mono`} />
        </label>
        {error && <Notice>{error}</Notice>}
        <div>
          <Button type="submit" variant="primary" size="sm" disabled={!valid || saving}>
            {saving ? "Adding…" : "Add finding"}
          </Button>
        </div>
      </form>
    </Sheet>
  );
}
