import { ChevronDown, Cpu, RefreshCw } from "lucide-react";
import type { OllamaModel } from "../types/ollama";
import { IconButton, SectionHeading } from "./ui";

interface ModelSelectorProps {
  models: OllamaModel[];
  loading: boolean;
  error: string | null;
  selectedModel: string | null;
  onSelectModel: (model: string) => void;
  onRefresh: () => void;
  /** True while an agent is selected — the agent's configured model is authoritative. */
  disabled?: boolean;
}

export function ModelSelector({
  models,
  loading,
  error,
  selectedModel,
  onSelectModel,
  onRefresh,
  disabled,
}: ModelSelectorProps) {
  return (
    <section>
      <SectionHeading
        actions={
          <IconButton
            icon={RefreshCw}
            label="Refresh model list"
            size="sm"
            onClick={onRefresh}
            disabled={loading}
            className={loading ? "animate-spin" : undefined}
          />
        }
      >
        Model
      </SectionHeading>

      {error && <p className="text-xs text-critical">{error}</p>}

      {!error && models.length === 0 && !loading && <p className="text-xs text-muted">No models installed</p>}

      {models.length > 0 && (
        <div className="relative">
          <Cpu size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
          <select
            className="w-full appearance-none rounded-lg border border-border bg-surface-2 py-2 pl-8 pr-8 text-sm text-text outline-none transition-colors focus:border-primary/60 disabled:cursor-not-allowed disabled:opacity-50"
            value={selectedModel ?? ""}
            onChange={(e) => onSelectModel(e.target.value)}
            disabled={disabled}
            title={disabled ? "Set by the selected agent — deselect it to choose a model manually" : undefined}
          >
            {models.map((model) => (
              <option key={model.name} value={model.name}>
                {model.name}
              </option>
            ))}
          </select>
          <ChevronDown size={14} className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-muted" />
        </div>
      )}
      {disabled && <p className="mt-1.5 text-xs italic text-muted">Set by the selected agent</p>}
    </section>
  );
}
