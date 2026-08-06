import type { ReactNode } from "react";
import { RotateCcw } from "lucide-react";
import type { Settings } from "../types/settings";
import { Button, Sheet } from "./ui";

interface SettingsPanelProps {
  open: boolean;
  settings: Settings;
  onChange: (partial: Partial<Settings>) => void;
  onReset: () => void;
  onClose: () => void;
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="mb-5 block">
      <span className="mb-1.5 block text-xs font-medium text-muted">{label}</span>
      {children}
    </label>
  );
}

export function SettingsPanel({ open, settings, onChange, onReset, onClose }: SettingsPanelProps) {
  return (
    <Sheet open={open} onClose={onClose} title="Settings">
      <Field label={`Temperature (${settings.temperature.toFixed(2)})`}>
        <input
          type="range"
          min={0}
          max={2}
          step={0.05}
          value={settings.temperature}
          onChange={(e) => onChange({ temperature: Number(e.target.value) })}
          className="w-full accent-primary"
        />
      </Field>

      <Field label={`Top P (${settings.topP.toFixed(2)})`}>
        <input
          type="range"
          min={0}
          max={1}
          step={0.05}
          value={settings.topP}
          onChange={(e) => onChange({ topP: Number(e.target.value) })}
          className="w-full accent-primary"
        />
      </Field>

      <Field label="Max Tokens (0 = unlimited)">
        <input
          type="number"
          min={0}
          step={1}
          value={settings.maxTokens}
          onChange={(e) => onChange({ maxTokens: Number(e.target.value) })}
          className="w-full rounded-lg border border-border bg-surface-2 px-3 py-2 text-sm text-text outline-none focus:border-primary/60 focus-visible:ring-2 focus-visible:ring-primary/60"
        />
      </Field>

      <Field label="Context Size (0 = model default)">
        <input
          type="number"
          min={0}
          step={1}
          value={settings.contextSize}
          onChange={(e) => onChange({ contextSize: Number(e.target.value) })}
          className="w-full rounded-lg border border-border bg-surface-2 px-3 py-2 text-sm text-text outline-none focus:border-primary/60 focus-visible:ring-2 focus-visible:ring-primary/60"
        />
      </Field>

      <Field label="Keep Alive">
        <input
          type="text"
          value={settings.keepAlive}
          placeholder="5m"
          onChange={(e) => onChange({ keepAlive: e.target.value })}
          className="w-full rounded-lg border border-border bg-surface-2 px-3 py-2 text-sm text-text outline-none placeholder:text-muted focus:border-primary/60 focus-visible:ring-2 focus-visible:ring-primary/60"
        />
      </Field>

      <Button variant="secondary" size="sm" icon={RotateCcw} onClick={onReset}>
        Reset to defaults
      </Button>
    </Sheet>
  );
}
