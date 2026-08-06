import { ChevronDown, Cpu, RefreshCw } from "lucide-react";
import type { OllamaModel } from "../types/ollama";
import { IconButton, SectionHeading, Skeleton } from "./ui";

interface ModelSelectorProps {
  models: OllamaModel[];
  loading: boolean;
  error: string | null;
  selectedModel: string | null;
  onSelectModel: (model: string) => void;
  onRefresh: () => void;
}

/** Picks the model for a fresh manual (no-agent) chat session — each agent's own session carries
 * its own model (seeded from the agent's default, overridable from that session's own header), so
 * this selector is no longer "locked" by an active agent the way it used to be. */
export function ModelSelector({ models, loading, error, selectedModel, onSelectModel, onRefresh }: ModelSelectorProps) {
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
      {loading && models.length === 0 && <Skeleton className="h-9 w-full" />}

      {models.length > 0 && (
        <div className="relative">
          <Cpu size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
          <select
            className="w-full appearance-none rounded-lg border border-border bg-surface-2 py-2 pl-8 pr-8 text-sm text-text outline-none transition-colors focus:border-primary/60 focus-visible:ring-2 focus-visible:ring-primary/60"
            value={selectedModel ?? ""}
            onChange={(e) => onSelectModel(e.target.value)}
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
    </section>
  );
}
