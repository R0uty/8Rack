import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Cpu, MessageSquare, Search, Settings, ServerCog, ShieldAlert, Sun, Workflow } from "lucide-react";
import type { AgentWithStatus } from "../../types/agent";
import type { OllamaModel } from "../../types/ollama";
import { iconFor } from "../../lib/icons";
import { cn } from "../../lib/cn";
import { type AppView, VIEW_LABEL } from "./types";

interface Command {
  id: string;
  label: string;
  hint: string;
  icon: typeof MessageSquare;
  keywords: string;
  run: () => void;
}

interface CommandPaletteProps {
  open: boolean;
  onClose: () => void;
  onChangeView: (view: AppView) => void;
  agents: AgentWithStatus[];
  onSelectAgent: (agent: AgentWithStatus) => void;
  models: OllamaModel[];
  onSelectModel: (model: string) => void;
  onOpenSettings: () => void;
  onToggleTheme: () => void;
}

const VIEW_ICON: Record<AppView, typeof MessageSquare> = {
  chat: MessageSquare,
  workbench: ServerCog,
  plans: Workflow,
  findings: ShieldAlert,
};

/** Cmd/Ctrl+K palette - real, client-side actions only (view switching, agent/model selection,
 * settings, theme). No fake "AI command" input: everything here maps to an existing setter. */
export function CommandPalette({
  open,
  onClose,
  onChangeView,
  agents,
  onSelectAgent,
  models,
  onSelectModel,
  onOpenSettings,
  onToggleTheme,
}: CommandPaletteProps) {
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setQuery("");
      setActiveIndex(0);
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  const commands: Command[] = useMemo(() => {
    const list: Command[] = [];

    (Object.keys(VIEW_LABEL) as AppView[]).forEach((view) => {
      list.push({
        id: `view-${view}`,
        label: `Go to ${VIEW_LABEL[view]}`,
        hint: "View",
        icon: VIEW_ICON[view],
        keywords: `view ${view} ${VIEW_LABEL[view]}`,
        run: () => onChangeView(view),
      });
    });

    agents.forEach((agent) => {
      list.push({
        id: `agent-${agent.id}`,
        label: `Chat with ${agent.name}`,
        hint: agent.status === "online" ? "Agent · online" : "Agent · offline",
        icon: iconFor(agent.icon),
        keywords: `agent ${agent.name} ${agent.description} ${agent.model}`,
        run: () => onSelectAgent(agent),
      });
    });

    models.forEach((model) => {
      list.push({
        id: `model-${model.name}`,
        label: `Set manual chat model to ${model.name}`,
        hint: "Model",
        icon: Cpu,
        keywords: `model ${model.name}`,
        run: () => onSelectModel(model.name),
      });
    });

    list.push({
      id: "settings",
      label: "Open Settings",
      hint: "Action",
      icon: Settings,
      keywords: "settings preferences temperature",
      run: onOpenSettings,
    });
    list.push({
      id: "theme",
      label: "Toggle theme",
      hint: "Action",
      icon: Sun,
      keywords: "theme dark light appearance",
      run: onToggleTheme,
    });

    return list;
  }, [agents, models, onChangeView, onOpenSettings, onSelectAgent, onSelectModel, onToggleTheme]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return commands;
    return commands.filter((c) => c.keywords.toLowerCase().includes(q));
  }, [commands, query]);

  const runAndClose = (command: Command) => {
    command.run();
    onClose();
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIndex((i) => Math.min(i + 1, filtered.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const command = filtered[activeIndex];
      if (command) runAndClose(command);
    } else if (e.key === "Escape") {
      onClose();
    }
  };

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.15 }}
          className="fixed inset-0 z-50 flex items-start justify-center bg-black/50 pt-[15vh] backdrop-blur-sm"
          onClick={onClose}
        >
          <motion.div
            initial={{ y: -12, opacity: 0, scale: 0.98 }}
            animate={{ y: 0, opacity: 1, scale: 1 }}
            exit={{ y: -12, opacity: 0, scale: 0.98 }}
            transition={{ duration: 0.15 }}
            className="w-full max-w-lg overflow-hidden rounded-panel border border-border bg-surface/95 shadow-2xl backdrop-blur-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center gap-2.5 border-b border-border px-4 py-3">
              <Search size={16} className="text-muted" />
              <input
                ref={inputRef}
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value);
                  setActiveIndex(0);
                }}
                onKeyDown={handleKeyDown}
                placeholder="Search or run a command…"
                className="flex-1 bg-transparent text-sm text-text outline-none placeholder:text-muted"
              />
              <kbd className="rounded border border-border bg-surface-2 px-1.5 py-0.5 font-mono text-[10px] text-muted">
                Esc
              </kbd>
            </div>

            <div className="max-h-80 overflow-y-auto p-2">
              {filtered.length === 0 && <p className="px-3 py-6 text-center text-sm text-muted">No matches</p>}
              {filtered.map((command, i) => {
                const Icon = command.icon;
                return (
                  <button
                    key={command.id}
                    type="button"
                    onMouseEnter={() => setActiveIndex(i)}
                    onClick={() => runAndClose(command)}
                    className={cn(
                      "flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-sm transition-colors",
                      i === activeIndex ? "bg-primary-dim text-primary" : "text-text hover:bg-card",
                    )}
                  >
                    <Icon size={15} strokeWidth={2} />
                    <span className="flex-1 truncate">{command.label}</span>
                    <span className="text-[11px] text-muted">{command.hint}</span>
                  </button>
                );
              })}
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
