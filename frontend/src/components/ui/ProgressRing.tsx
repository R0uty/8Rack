import { cn } from "../../lib/cn";

interface ProgressRingProps {
  size?: number;
  /** Omit for an indeterminate spin (used for "running"/"busy" states where no real progress
   * number exists). */
  className?: string;
}

/** Indeterminate spinning ring - used for busy/running/streaming indicators. No component in
 * this app tracks real numeric progress, so this deliberately doesn't offer a `value` prop that
 * would invite faking one. */
export function ProgressRing({ size = 16, className }: ProgressRingProps) {
  const stroke = Math.max(1.5, size / 8);
  const radius = size / 2 - stroke;
  const circumference = 2 * Math.PI * radius;

  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      className={cn("animate-spin text-primary", className)}
      style={{ animationDuration: "1.1s" }}
    >
      <circle
        cx={size / 2}
        cy={size / 2}
        r={radius}
        fill="none"
        stroke="currentColor"
        strokeOpacity={0.15}
        strokeWidth={stroke}
      />
      <circle
        cx={size / 2}
        cy={size / 2}
        r={radius}
        fill="none"
        stroke="currentColor"
        strokeWidth={stroke}
        strokeLinecap="round"
        strokeDasharray={circumference}
        strokeDashoffset={circumference * 0.75}
      />
    </svg>
  );
}
