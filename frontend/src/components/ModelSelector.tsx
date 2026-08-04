import type { OllamaModel } from "../types/ollama";

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
    <section className="model-selector">
      <div className="model-selector__header">
        <h2 className="model-selector__heading">Model</h2>
        <button
          type="button"
          className="model-selector__refresh"
          onClick={onRefresh}
          disabled={loading}
          title="Refresh model list"
        >
          {loading ? "..." : "↻"}
        </button>
      </div>

      {error && <p className="model-selector__error">{error}</p>}

      {!error && models.length === 0 && !loading && (
        <p className="model-selector__placeholder">No models installed</p>
      )}

      {models.length > 0 && (
        <select
          className="model-selector__select"
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
      )}
      {disabled && <p className="model-selector__locked-note">Set by the selected agent</p>}
    </section>
  );
}
