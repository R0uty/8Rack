import { useState } from "react";
import { FolderKanban, Plus, RefreshCw, X } from "lucide-react";
import type { Project } from "../types/project";
import { Button, GlassPanel, IconButton, SectionHeading } from "./ui";
import { cn } from "../lib/cn";

interface ProjectPanelProps {
  projects: Project[];
  loading: boolean;
  error: string | null;
  selectedProjectId: string | null;
  onSelect: (project: Project) => void;
  onCreate: (name: string, notes: string) => Promise<unknown>;
  onDelete: (id: string) => Promise<unknown>;
  onRefresh: () => void;
  /** True while a task is active (non-terminal) - switching or deleting the project mid-task would
   * strand the running task's execution history behind a different project's view. */
  disabled?: boolean;
}

export function ProjectPanel({
  projects,
  loading,
  error,
  selectedProjectId,
  onSelect,
  onCreate,
  onDelete,
  onRefresh,
  disabled = false,
}: ProjectPanelProps) {
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  // Two-step delete (arm, then confirm) instead of a native confirm() dialog - keeps this
  // in-page and scriptable rather than blocking on a browser-native modal.
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  const handleCreate = async () => {
    if (!name.trim() || busy) return;
    setBusy(true);
    setCreateError(null);
    try {
      await onCreate(name.trim(), notes.trim());
      setName("");
      setNotes("");
      setCreating(false);
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : "Failed to create project");
    } finally {
      setBusy(false);
    }
  };

  const handleDelete = async (id: string) => {
    setBusy(true);
    try {
      await onDelete(id);
    } finally {
      setConfirmDeleteId(null);
      setBusy(false);
    }
  };

  return (
    <section>
      <SectionHeading
        actions={
          <div className="flex items-center gap-1.5">
            <IconButton
              icon={RefreshCw}
              label="Refresh projects"
              size="sm"
              onClick={onRefresh}
              disabled={loading}
              className={loading ? "animate-spin" : undefined}
            />
            <Button variant="secondary" size="sm" icon={creating ? X : Plus} onClick={() => setCreating((c) => !c)} disabled={disabled}>
              {creating ? "Cancel" : "New"}
            </Button>
          </div>
        }
      >
        Projects
      </SectionHeading>

      {error && <p className="mb-2 text-xs text-critical">{error}</p>}
      {!error && !loading && projects.length === 0 && !creating && (
        <p className="text-xs text-muted">
          No projects yet — every tool execution and Orchestrator task belongs to a project. Create one to get
          started.
        </p>
      )}

      {creating && (
        <GlassPanel padding="md" className="mb-3">
          <input
            type="text"
            placeholder="Project name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            disabled={busy}
            autoFocus
            className="w-full rounded-lg border border-border bg-surface-2 px-3 py-2 text-sm text-text outline-none placeholder:text-muted focus:border-primary/60"
          />
          <textarea
            placeholder="Notes (target scope, program, anything worth remembering)"
            rows={2}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            disabled={busy}
            className="mt-2 w-full resize-none rounded-lg border border-border bg-surface-2 px-3 py-2 text-sm text-text outline-none placeholder:text-muted focus:border-primary/60"
          />
          <Button variant="primary" size="sm" onClick={handleCreate} disabled={!name.trim() || busy} className="mt-2.5">
            {busy ? "Creating…" : "Create"}
          </Button>
          {createError && <p className="mt-2 text-xs text-critical">{createError}</p>}
        </GlassPanel>
      )}

      {projects.length > 0 && (
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {projects.map((project) => {
            const active = project.id === selectedProjectId;
            const confirming = confirmDeleteId === project.id;

            if (confirming) {
              return (
                <GlassPanel key={project.id} padding="md" className="border-critical/40">
                  <p className="mb-2 text-xs text-text">Delete "{project.name}"?</p>
                  <div className="flex gap-2">
                    <Button variant="danger" size="sm" onClick={() => handleDelete(project.id)} disabled={busy}>
                      Delete
                    </Button>
                    <Button variant="secondary" size="sm" onClick={() => setConfirmDeleteId(null)} disabled={busy}>
                      Cancel
                    </Button>
                  </div>
                </GlassPanel>
              );
            }

            return (
              <GlassPanel
                key={project.id}
                as="button"
                interactive
                padding="md"
                onClick={() => onSelect(project)}
                aria-disabled={disabled}
                title={active ? "Click to deselect" : project.notes || project.name}
                className={cn("group relative text-left", active && "border-primary/50 bg-card-hover", disabled && "pointer-events-none opacity-60")}
              >
                <div className="flex items-start gap-2">
                  <FolderKanban size={14} className={cn("mt-0.5 shrink-0", active ? "text-primary" : "text-muted")} />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium text-text">{project.name}</div>
                    {project.notes && <div className="mt-0.5 truncate text-xs text-muted">{project.notes}</div>}
                  </div>
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      setConfirmDeleteId(project.id);
                    }}
                    disabled={disabled}
                    title="Delete project"
                    className="shrink-0 rounded p-0.5 text-muted opacity-0 transition-opacity hover:text-critical group-hover:opacity-100"
                  >
                    <X size={13} />
                  </button>
                </div>
              </GlassPanel>
            );
          })}
        </div>
      )}
    </section>
  );
}
