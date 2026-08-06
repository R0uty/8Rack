import { Command, Moon, Settings, Sun } from "lucide-react";
import type { Theme } from "../../hooks/useTheme";
import { FOCUS_RING, IconButton } from "../ui";
import { type AppView, VIEW_LABEL } from "./types";

interface TopBarProps {
  activeView: AppView;
  agentName: string | null;
  selectedModel: string | null;
  theme: Theme;
  onToggleTheme: () => void;
  onOpenSettings: () => void;
  onOpenCommandPalette: () => void;
}

export function TopBar({
  activeView,
  agentName,
  selectedModel,
  theme,
  onToggleTheme,
  onOpenSettings,
  onOpenCommandPalette,
}: TopBarProps) {
  return (
    <div className="flex items-center gap-3 px-4 py-4">
      <h1 className="text-base font-semibold text-text">{VIEW_LABEL[activeView]}</h1>

      <button
        type="button"
        onClick={onOpenCommandPalette}
        className={`ml-2 flex flex-1 max-w-md items-center gap-2 rounded-full border border-border bg-card/60 px-4 py-2 text-left text-sm text-muted backdrop-blur-xl transition-colors hover:border-border-strong hover:text-text ${FOCUS_RING}`}
      >
        <Command size={14} />
        <span className="flex-1">Search or run a command…</span>
        <kbd className="rounded border border-border bg-surface-2 px-1.5 py-0.5 font-mono text-[10px]">⌘K</kbd>
      </button>

      <div className="ml-auto flex items-center gap-2">
        {(agentName || selectedModel) && (
          <div className="hidden items-center gap-2 rounded-full border border-border bg-card/60 px-3 py-1.5 text-xs text-muted backdrop-blur-xl sm:flex">
            {agentName && <span className="font-medium text-text">{agentName}</span>}
            {agentName && selectedModel && <span className="text-border-strong">·</span>}
            {selectedModel && <span className="font-mono">{selectedModel}</span>}
          </div>
        )}

        <IconButton
          icon={theme === "dark" ? Sun : Moon}
          label={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}
          onClick={onToggleTheme}
        />
        <IconButton icon={Settings} label="Settings" onClick={onOpenSettings} />
      </div>
    </div>
  );
}
