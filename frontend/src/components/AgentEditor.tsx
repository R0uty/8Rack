import { useEffect, useState, type ReactNode } from "react";
import { Trash2 } from "lucide-react";
import type { Agent, AgentWithStatus } from "../types/agent";
import type { ExecToolCategory, ExecToolWithStatus } from "../types/execTool";
import type { OllamaModel } from "../types/ollama";
import { Button, Collapsible, Sheet } from "./ui";
import { cn } from "../lib/cn";

interface AgentEditorProps {
  open: boolean;
  /** null means "create a new agent" - every other value is the agent being edited. */
  agent: AgentWithStatus | null;
  models: OllamaModel[];
  execTools: ExecToolWithStatus[];
  onSave: (id: string | null, agent: Agent) => Promise<unknown>;
  onDelete: (id: string) => Promise<unknown>;
  onClose: () => void;
}

interface FormState {
  id: string;
  name: string;
  description: string;
  model: string;
  systemPrompt: string;
  temperature: number;
  topP: number;
  maxTokens: number;
  icon: string;
  color: string;
  enabled: boolean;
  /** "all" maps to execTools: undefined (unrestricted, today's default behavior); "custom" maps
   * to execTools: string[] (including an empty array, meaning no tools at all). */
  execToolsMode: "all" | "custom";
  execTools: string[];
}

const EMPTY_FORM: FormState = {
  id: "",
  name: "",
  description: "",
  model: "",
  systemPrompt: "",
  temperature: 0.7,
  topP: 0.9,
  maxTokens: 1024,
  icon: "🤖",
  color: "#7aa2f7",
  enabled: true,
  execToolsMode: "all",
  execTools: [],
};

function formFromAgent(agent: AgentWithStatus): FormState {
  return {
    id: agent.id,
    name: agent.name,
    description: agent.description,
    model: agent.model,
    systemPrompt: agent.systemPrompt,
    temperature: agent.temperature,
    topP: agent.topP,
    maxTokens: agent.maxTokens,
    icon: agent.icon,
    color: agent.color,
    enabled: agent.enabled,
    execToolsMode: agent.execTools === undefined ? "all" : "custom",
    execTools: agent.execTools ?? [],
  };
}

const CATEGORY_LABEL: Record<ExecToolCategory, string> = {
  filesystem: "Filesystem",
  network: "Network",
  recon: "Recon",
  exec: "Execution",
  vcs: "Version Control",
};

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="mb-4 block">
      <span className="mb-1.5 block text-xs font-medium text-muted">{label}</span>
      {children}
    </label>
  );
}

const TEXT_INPUT_CLASS =
  "w-full rounded-lg border border-border bg-surface-2 px-3 py-2 text-sm text-text outline-none placeholder:text-muted focus:border-primary/60 focus-visible:ring-2 focus-visible:ring-primary/60";

export function AgentEditor({ open, agent, models, execTools, onSave, onDelete, onClose }: AgentEditorProps) {
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  // Re-seed the form every time the sheet opens (or the target agent changes) rather than once on
  // mount - AgentEditor stays mounted across open/close, and swapping between "edit A" -> close ->
  // "edit B" without a remount otherwise leaves A's edits sitting in the form.
  useEffect(() => {
    if (!open) return;
    setForm(agent ? formFromAgent(agent) : { ...EMPTY_FORM, model: models[0]?.name ?? "" });
    setError(null);
    setConfirmingDelete(false);
  }, [open, agent, models]);

  const isEditing = agent !== null;

  const toggleExecTool = (toolId: string) => {
    setForm((f) => ({
      ...f,
      execTools: f.execTools.includes(toolId) ? f.execTools.filter((t) => t !== toolId) : [...f.execTools, toolId],
    }));
  };

  const toolsByCategory = execTools.reduce<Partial<Record<ExecToolCategory, ExecToolWithStatus[]>>>((acc, tool) => {
    (acc[tool.category] ??= []).push(tool);
    return acc;
  }, {});

  const handleSave = async () => {
    if (!form.id.trim() || !form.name.trim() || !form.model.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      const payload: Agent = {
        id: form.id.trim(),
        name: form.name.trim(),
        description: form.description.trim(),
        model: form.model,
        systemPrompt: form.systemPrompt,
        temperature: form.temperature,
        topP: form.topP,
        maxTokens: form.maxTokens,
        icon: form.icon.trim() || "🤖",
        color: form.color,
        enabled: form.enabled,
        execTools: form.execToolsMode === "custom" ? form.execTools : undefined,
      };
      await onSave(isEditing ? agent.id : null, payload);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save agent");
    } finally {
      setBusy(false);
    }
  };

  const handleDelete = async () => {
    if (!isEditing || busy) return;
    setBusy(true);
    setError(null);
    try {
      await onDelete(agent.id);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete agent");
      setBusy(false);
    }
  };

  return (
    <Sheet open={open} onClose={onClose} title={isEditing ? `Edit ${agent.name}` : "New Agent"} width="max-w-lg">
      <Field label="Id">
        <input
          type="text"
          value={form.id}
          disabled={isEditing || busy}
          placeholder="my-agent"
          onChange={(e) => setForm((f) => ({ ...f, id: e.target.value.trim().toLowerCase() }))}
          className={cn(TEXT_INPUT_CLASS, "font-mono disabled:opacity-60")}
        />
        {!isEditing && <p className="mt-1 text-[11px] text-muted">Lowercase letters, numbers, and hyphens only.</p>}
      </Field>

      <Field label="Name">
        <input
          type="text"
          value={form.name}
          disabled={busy}
          onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
          className={TEXT_INPUT_CLASS}
        />
      </Field>

      <Field label="Description">
        <input
          type="text"
          value={form.description}
          disabled={busy}
          onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
          className={TEXT_INPUT_CLASS}
        />
      </Field>

      <Field label="Model">
        <select
          value={form.model}
          disabled={busy}
          onChange={(e) => setForm((f) => ({ ...f, model: e.target.value }))}
          className={TEXT_INPUT_CLASS}
        >
          {form.model && !models.some((m) => m.name === form.model) && <option value={form.model}>{form.model}</option>}
          {models.map((m) => (
            <option key={m.name} value={m.name}>
              {m.name}
            </option>
          ))}
        </select>
      </Field>

      <Field label="System Prompt">
        <textarea
          value={form.systemPrompt}
          disabled={busy}
          rows={5}
          onChange={(e) => setForm((f) => ({ ...f, systemPrompt: e.target.value }))}
          className={cn(TEXT_INPUT_CLASS, "resize-none")}
        />
      </Field>

      <Field label={`Temperature (${form.temperature.toFixed(2)})`}>
        <input
          type="range"
          min={0}
          max={2}
          step={0.05}
          value={form.temperature}
          disabled={busy}
          onChange={(e) => setForm((f) => ({ ...f, temperature: Number(e.target.value) }))}
          className="w-full accent-primary"
        />
      </Field>

      <Field label={`Top P (${form.topP.toFixed(2)})`}>
        <input
          type="range"
          min={0}
          max={1}
          step={0.05}
          value={form.topP}
          disabled={busy}
          onChange={(e) => setForm((f) => ({ ...f, topP: Number(e.target.value) }))}
          className="w-full accent-primary"
        />
      </Field>

      <Field label="Max Tokens (0 = unlimited)">
        <input
          type="number"
          min={0}
          step={1}
          value={form.maxTokens}
          disabled={busy}
          onChange={(e) => setForm((f) => ({ ...f, maxTokens: Number(e.target.value) }))}
          className={TEXT_INPUT_CLASS}
        />
      </Field>

      <div className="mb-4 flex gap-3">
        <Field label="Icon">
          <input
            type="text"
            value={form.icon}
            disabled={busy}
            maxLength={4}
            onChange={(e) => setForm((f) => ({ ...f, icon: e.target.value }))}
            className={cn(TEXT_INPUT_CLASS, "w-16 text-center")}
          />
        </Field>
        <Field label="Color">
          <input
            type="color"
            value={form.color}
            disabled={busy}
            onChange={(e) => setForm((f) => ({ ...f, color: e.target.value }))}
            className="h-[38px] w-16 rounded-lg border border-border bg-surface-2 p-1"
          />
        </Field>
      </div>

      <label className="mb-5 flex items-center gap-2 text-sm text-text">
        <input
          type="checkbox"
          checked={form.enabled}
          disabled={busy}
          onChange={(e) => setForm((f) => ({ ...f, enabled: e.target.checked }))}
          className="accent-primary"
        />
        Enabled
      </label>

      <div className="mb-5">
        <span className="mb-1.5 block text-xs font-medium text-muted">Orchestrator tool access</span>
        <div className="mb-2 flex gap-1.5">
          <Button
            variant={form.execToolsMode === "all" ? "primary" : "secondary"}
            size="sm"
            disabled={busy}
            onClick={() => setForm((f) => ({ ...f, execToolsMode: "all" }))}
          >
            All tools
          </Button>
          <Button
            variant={form.execToolsMode === "custom" ? "primary" : "secondary"}
            size="sm"
            disabled={busy}
            onClick={() => setForm((f) => ({ ...f, execToolsMode: "custom" }))}
          >
            Select specific tools
          </Button>
        </div>

        {form.execToolsMode === "custom" && (
          <div className="flex flex-col gap-1.5 rounded-lg border border-border bg-surface-2 p-2.5">
            {(Object.keys(toolsByCategory) as ExecToolCategory[]).map((category) => (
              <Collapsible
                key={category}
                defaultOpen
                trigger={
                  <span className="text-xs font-medium text-muted">
                    {CATEGORY_LABEL[category]} ({toolsByCategory[category]!.filter((t) => form.execTools.includes(t.id)).length}/
                    {toolsByCategory[category]!.length})
                  </span>
                }
              >
                <div className="flex flex-col gap-1 pl-1">
                  {toolsByCategory[category]!.map((tool) => (
                    <label key={tool.id} className="flex items-center gap-2 py-0.5 text-sm text-text">
                      <input
                        type="checkbox"
                        checked={form.execTools.includes(tool.id)}
                        disabled={busy}
                        onChange={() => toggleExecTool(tool.id)}
                        className="accent-primary"
                      />
                      <span className="truncate">{tool.name}</span>
                      <span className="truncate font-mono text-[11px] text-muted">{tool.id}</span>
                    </label>
                  ))}
                </div>
              </Collapsible>
            ))}
            {execTools.length === 0 && <p className="py-1 text-xs text-muted">No exec tools registered.</p>}
          </div>
        )}
      </div>

      {error && <p className="mb-3 text-xs text-critical">{error}</p>}

      <div className="flex items-center justify-between gap-2">
        <Button
          variant="primary"
          size="sm"
          onClick={handleSave}
          disabled={busy || !form.id.trim() || !form.name.trim() || !form.model.trim()}
        >
          {busy ? "Saving…" : isEditing ? "Save changes" : "Create agent"}
        </Button>

        {isEditing &&
          (confirmingDelete ? (
            <div className="flex items-center gap-1.5">
              <span className="text-xs text-muted">Delete?</span>
              <Button variant="danger" size="sm" onClick={handleDelete} disabled={busy}>
                Confirm
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setConfirmingDelete(false)} disabled={busy}>
                Cancel
              </Button>
            </div>
          ) : (
            <Button variant="danger" size="sm" icon={Trash2} onClick={() => setConfirmingDelete(true)} disabled={busy}>
              Delete
            </Button>
          ))}
      </div>
    </Sheet>
  );
}
