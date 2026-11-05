import { Moon, Sun } from "lucide-react";
import type { Theme } from "../../hooks/useTheme";
import { IconButton } from "../ui";
import { type AppView, VIEW_LABEL } from "./types";

interface TopBarProps {
  activeView: AppView;
  theme: Theme;
  onToggleTheme: () => void;
}

export function TopBar({ activeView, theme, onToggleTheme }: TopBarProps) {
  return (
    <div className="flex items-center justify-between gap-3 px-4 py-3">
      <h1 className="text-base font-semibold text-text">{VIEW_LABEL[activeView]}</h1>
      <IconButton
        icon={theme === "dark" ? Sun : Moon}
        label={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}
        onClick={onToggleTheme}
      />
    </div>
  );
}
