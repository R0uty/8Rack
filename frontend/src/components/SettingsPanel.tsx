import type { Settings } from "../types/settings";

interface SettingsPanelProps {
  settings: Settings;
  onChange: (partial: Partial<Settings>) => void;
  onReset: () => void;
  onClose: () => void;
}

export function SettingsPanel({ settings, onChange, onReset, onClose }: SettingsPanelProps) {
  return (
    <div className="settings-panel__backdrop" onClick={onClose}>
      <div className="settings-panel" onClick={(e) => e.stopPropagation()}>
        <div className="settings-panel__header">
          <h2>Settings</h2>
          <button type="button" onClick={onClose} aria-label="Close settings">
            ✕
          </button>
        </div>

        <label className="settings-panel__field">
          <span>Temperature ({settings.temperature.toFixed(2)})</span>
          <input
            type="range"
            min={0}
            max={2}
            step={0.05}
            value={settings.temperature}
            onChange={(e) => onChange({ temperature: Number(e.target.value) })}
          />
        </label>

        <label className="settings-panel__field">
          <span>Top P ({settings.topP.toFixed(2)})</span>
          <input
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={settings.topP}
            onChange={(e) => onChange({ topP: Number(e.target.value) })}
          />
        </label>

        <label className="settings-panel__field">
          <span>Max Tokens (0 = unlimited)</span>
          <input
            type="number"
            min={0}
            step={1}
            value={settings.maxTokens}
            onChange={(e) => onChange({ maxTokens: Number(e.target.value) })}
          />
        </label>

        <label className="settings-panel__field">
          <span>Context Size (0 = model default)</span>
          <input
            type="number"
            min={0}
            step={1}
            value={settings.contextSize}
            onChange={(e) => onChange({ contextSize: Number(e.target.value) })}
          />
        </label>

        <label className="settings-panel__field">
          <span>Keep Alive</span>
          <input
            type="text"
            value={settings.keepAlive}
            placeholder="5m"
            onChange={(e) => onChange({ keepAlive: e.target.value })}
          />
        </label>

        <button type="button" className="settings-panel__reset" onClick={onReset}>
          Reset to defaults
        </button>
      </div>
    </div>
  );
}
