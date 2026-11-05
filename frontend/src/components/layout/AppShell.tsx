import type { ReactNode } from "react";

interface AppShellProps {
  sidebar: ReactNode;
  topBar: ReactNode;
  center: ReactNode;
}

/** Left sidebar and scrolling workspace - on a phone the sidebar stacks above it as a compact header. */
export function AppShell({ sidebar, topBar, center }: AppShellProps) {
  return (
    <div className="flex h-screen w-full flex-col overflow-hidden bg-bg text-text md:flex-row">
      {sidebar}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        {topBar}
        <main className="relative min-h-0 min-w-0 flex-1 overflow-y-auto p-4 pt-0">{center}</main>
      </div>
    </div>
  );
}
