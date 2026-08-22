/** Shared `<select>` styling, same precedent as Button.tsx's FOCUS_RING - previously defined in
 * FindingsView.tsx and imported by FindingsTimeline.tsx, which was one leg of a real import cycle
 * (see lib/findingStatus.ts for the other). */
export const SELECT_CLASS =
  "rounded-lg border border-border bg-surface-2 px-2.5 py-1.5 text-xs text-text outline-none focus:border-primary/60 focus-visible:ring-2 focus-visible:ring-primary/60";
