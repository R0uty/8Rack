import type { ReactNode } from "react";

interface AppShellProps {
  sidebar: ReactNode;
  topBar: ReactNode;
  center: ReactNode;
  rightPanel?: ReactNode;
}

/** Three-column desktop shell: fixed left sidebar, flexible center workspace, optional
 * context-aware right panel — with a floating top bar spanning center + right panel. */
export function AppShell({ sidebar, topBar, center, rightPanel }: AppShellProps) {
  return (
    <div className="flex h-screen w-full overflow-hidden bg-bg text-text">
      {sidebar}
      <div className="flex min-w-0 flex-1 flex-col">
        {topBar}
        <div className="flex min-h-0 flex-1 gap-4 overflow-hidden p-4 pt-0">
          <main className="relative min-w-0 flex-1 overflow-y-auto">{center}</main>
          {rightPanel && <aside className="hidden w-[340px] shrink-0 overflow-y-auto xl:block">{rightPanel}</aside>}
        </div>
      </div>
    </div>
  );
}
