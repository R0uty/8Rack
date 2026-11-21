import { useState } from "react";
import { Button, Notice, SELECT_CLASS, Sheet } from "./ui";
import type { AgentWithStatus } from "../types/agent";
import type { WorkOrderCreateInput } from "../types/workOrder";

interface NewWorkOrderSheetProps {
  open: boolean;
  agents: AgentWithStatus[];
  /** Pre-fills the target, e.g. when opened from an asset. */
  initialTarget?: string;
  onClose: () => void;
  /** `start` asks for the order to run at once, as the mission's run. */
  onCreate: (input: WorkOrderCreateInput, start: boolean) => Promise<void>;
}

const INPUT_CLASS =
  "w-full rounded-lg border border-border bg-surface-2 px-2.5 py-1.5 text-xs text-text outline-none placeholder:text-muted focus:border-primary/60 focus-visible:ring-2 focus-visible:ring-primary/60";

/** A work order by hand: any enabled agent, an objective, an optional target. The Director only
 * seeds Recon, Enumeration and Validation, so this is the way to reach every other agent. */
export function NewWorkOrderSheet({ open, agents, initialTarget, onClose, onCreate }: NewWorkOrderSheetProps) {
  const enabled = agents.filter((a) => a.enabled);
  const [agentId, setAgentId] = useState("");
  const [objective, setObjective] = useState("");
  const [target, setTarget] = useState(initialTarget ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const chosen = agentId || enabled[0]?.id || "";
  const valid = !!chosen && objective.trim().length > 0;

  const submit = async (start: boolean) => {
    if (!valid || saving) return;
    setSaving(true);
    setError(null);
    try {
      await onCreate({ agentId: chosen, objective: objective.trim(), target: target.trim() || undefined }, start);
      setObjective("");
      setTarget("");
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create the work order");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Sheet open={open} onClose={onClose} title="New work order" width="max-w-md">
      <div className="flex flex-col gap-3">
        <label className="flex flex-col gap-1 text-xs text-muted">
          Agent
          <select value={chosen} onChange={(e) => setAgentId(e.target.value)} className={SELECT_CLASS}>
            {enabled.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
                {a.status === "offline" ? " (model not available)" : ""}
              </option>
            ))}
          </select>
        </label>
        {enabled.find((a) => a.id === chosen)?.description && (
          <p className="text-[11px] text-muted">{enabled.find((a) => a.id === chosen)?.description}</p>
        )}
        <label className="flex flex-col gap-1 text-xs text-muted">
          Objective
          <textarea
            value={objective}
            onChange={(e) => setObjective(e.target.value)}
            rows={4}
            placeholder="What should the agent do? e.g. Check https://example.com/login for missing rate limiting"
            className={INPUT_CLASS}
          />
        </label>
        <label className="flex flex-col gap-1 text-xs text-muted">
          Target (optional)
          <input value={target} onChange={(e) => setTarget(e.target.value)} placeholder="example.com" className={INPUT_CLASS} />
        </label>
        {error && <Notice>{error}</Notice>}
        <div className="flex gap-2">
          <Button variant="primary" size="sm" onClick={() => submit(true)} disabled={!valid || saving}>
            Create and start
          </Button>
          <Button variant="secondary" size="sm" onClick={() => submit(false)} disabled={!valid || saving}>
            Create
          </Button>
        </div>
        <p className="text-[11px] text-muted">
          Started orders run on the server like any other: tool requests still wait in the dashboard's Needs you list.
        </p>
      </div>
    </Sheet>
  );
}
