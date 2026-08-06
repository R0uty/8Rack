import { cn } from "../../lib/cn";

interface SkeletonProps {
  className?: string;
}

/** Pulsing placeholder bar - shown while a list is loading for the first time (no data yet), so
 * the layout doesn't collapse to a blank gap between "loading" and the eventual content/empty
 * state. */
export function Skeleton({ className }: SkeletonProps) {
  return <div className={cn("animate-pulse rounded-md bg-card-hover", className)} />;
}

/** A skeleton shaped like an AgentList/ToolRegistry row: icon + two lines of text. */
export function SkeletonRow() {
  return (
    <div className="flex items-start gap-2.5 rounded-lg border border-transparent px-2.5 py-2">
      <Skeleton className="h-7 w-7 shrink-0 rounded-md" />
      <div className="min-w-0 flex-1 space-y-1.5 py-0.5">
        <Skeleton className="h-3 w-2/3" />
        <Skeleton className="h-2.5 w-full" />
      </div>
    </div>
  );
}

export function SkeletonRows({ count = 3 }: { count?: number }) {
  return (
    <div className="flex flex-col gap-1.5">
      {Array.from({ length: count }, (_, i) => (
        <SkeletonRow key={i} />
      ))}
    </div>
  );
}
