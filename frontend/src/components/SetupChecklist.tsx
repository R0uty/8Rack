import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, CheckCircle2, ChevronDown, ChevronRight, EyeOff, RefreshCw, XCircle } from "lucide-react";
import { Button, GlassPanel, Notice, SectionHeading } from "./ui";
import { fetchSetupStatus } from "../services/setupApi";
import { cn } from "../lib/cn";
import type { SetupItem, SetupStatus } from "../types/setup";

/** Hiding remembers which gaps were showing, so a new one brings the checklist back. */
const HIDDEN_KEY = "8rack.setupChecklistHidden";

function gapsKey(status: SetupStatus): string {
  return [status.ollama, ...status.models, ...status.tools]
    .filter((i) => i.state !== "ok")
    .map((i) => i.id)
    .sort()
    .join(",");
}

function readHidden(): string | null {
  try {
    return localStorage.getItem(HIDDEN_KEY);
  } catch {
    return null;
  }
}

const STATE_ICON = { ok: CheckCircle2, missing: XCircle, warning: AlertTriangle } as const;
const STATE_CLASS = { ok: "text-primary", missing: "text-critical", warning: "text-warning" } as const;
const STATE_LABEL = { ok: "ready", missing: "missing", warning: "optional, missing" } as const;

function Item({ item }: { item: SetupItem }) {
  const Icon = STATE_ICON[item.state];
  return (
    <li className="flex items-start gap-2 text-xs">
      <Icon size={14} className={cn("mt-0.5 shrink-0", STATE_CLASS[item.state])} aria-label={STATE_LABEL[item.state]} />
      <div className="min-w-0 flex-1">
        <span className="font-mono text-text">{item.label}</span>
        {item.detail && <span className="ml-1.5 text-muted">{item.detail}</span>}
        {item.fix && (
          <code className="mt-1 block overflow-x-auto whitespace-pre rounded-md bg-surface-2 px-2 py-1 font-mono text-[11px] text-text">
            {item.fix}
          </code>
        )}
      </div>
    </li>
  );
}

function Group({ title, items, defaultOpen }: { title: string; items: SetupItem[]; defaultOpen: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  if (items.length === 0) return null;
  const missing = items.filter((i) => i.state !== "ok").length;
  const Chevron = open ? ChevronDown : ChevronRight;
  return (
    <div>
      <button type="button" aria-expanded={open} onClick={() => setOpen((o) => !o)} className="flex items-center gap-1 text-xs font-medium text-text">
        <Chevron size={13} aria-hidden />
        {title}
        <span className="text-muted">{missing === 0 ? "· all ready" : `· ${missing} of ${items.length} need attention`}</span>
      </button>
      {open && (
        <ul className="mt-2 flex flex-col gap-1.5 pl-4">
          {/* Problems first - a long list of ready tools shouldn't push them out of view. */}
          {[...items].sort((a, b) => Number(a.state === "ok") - Number(b.state === "ok")).map((item) => (
            <Item key={item.id} item={item} />
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * First-run checklist: Ollama, each agent's model, the embedding model and the recon tools, with the
 * command that fixes each gap. Shown only while something is missing - before this, each of these
 * surfaced later as a failed work order.
 */
export function SetupChecklist() {
  const [status, setStatus] = useState<SetupStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [hidden, setHidden] = useState<string | null>(readHidden);

  const check = useCallback(async () => {
    setChecking(true);
    try {
      setStatus(await fetchSetupStatus());
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't check the setup");
    } finally {
      setChecking(false);
    }
  }, []);

  useEffect(() => {
    void check();
  }, [check]);

  if (error) return <Notice tone="warning">Couldn't check the setup: {error}</Notice>;
  if (!status || status.ready || hidden === gapsKey(status)) return null;

  const hide = () => {
    const key = gapsKey(status);
    setHidden(key);
    try {
      localStorage.setItem(HIDDEN_KEY, key);
    } catch {
      // Hidden for this visit only.
    }
  };

  return (
    <GlassPanel padding="md" className="flex flex-col gap-3" role="region" aria-label="Setup checklist">
      <div className="flex items-center justify-between gap-2">
        <SectionHeading>Before the factory can run</SectionHeading>
        <div className="flex items-center gap-1">
          <Button variant="ghost" size="sm" icon={RefreshCw} disabled={checking} onClick={check}>
            {checking ? "Checking…" : "Check again"}
          </Button>
          {status.ollama.state === "ok" && (
            <Button variant="ghost" size="sm" icon={EyeOff} onClick={hide}>
              Hide
            </Button>
          )}
        </div>
      </div>
      <ul className="flex flex-col gap-1.5">
        <Item item={status.ollama} />
      </ul>
      <Group title="Models" items={status.models} defaultOpen={status.models.some((m) => m.state === "missing")} />
      <Group title="Recon tools" items={status.tools} defaultOpen={status.tools.some((t) => t.state === "missing")} />
    </GlassPanel>
  );
}
