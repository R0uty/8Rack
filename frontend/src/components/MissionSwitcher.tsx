import { Pencil, Plus } from "lucide-react";
import type { Mission } from "../types/mission";
import { Button, IconButton, SELECT_CLASS } from "./ui";
import { cn } from "../lib/cn";

interface MissionSwitcherProps {
  missions: Mission[];
  selected: Mission | null;
  loading: boolean;
  error: string | null;
  /** True while the factory is advancing this mission - its live output belongs to this selection. */
  disabled: boolean;
  onSelect: (id: string) => void;
  onNew: () => void;
  onEdit: (mission: Mission) => void;
}

export function MissionSwitcher({ missions, selected, loading, error, disabled, onSelect, onNew, onEdit }: MissionSwitcherProps) {
  if (error) return <p className="text-xs text-critical">{error}</p>;
  if (!loading && missions.length === 0) {
    return (
      <Button variant="primary" size="sm" icon={Plus} onClick={onNew} className="w-full justify-center">
        New mission
      </Button>
    );
  }

  return (
    <div className="flex items-center gap-1">
      <select
        aria-label="Mission"
        value={selected?.id ?? ""}
        disabled={disabled || (loading && missions.length === 0)}
        onChange={(e) => onSelect(e.target.value)}
        className={cn(SELECT_CLASS, "min-w-0 flex-1 disabled:opacity-60")}
      >
        {missions.map((m) => (
          <option key={m.id} value={m.id}>
            {m.name}
          </option>
        ))}
      </select>
      {selected && <IconButton icon={Pencil} label="Edit mission" size="sm" disabled={disabled} onClick={() => onEdit(selected)} />}
      <IconButton icon={Plus} label="New mission" size="sm" disabled={disabled} onClick={onNew} />
    </div>
  );
}
