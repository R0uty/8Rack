import type { ComponentPropsWithoutRef, ElementType, ReactNode } from "react";
import { cn } from "../../lib/cn";

interface GlassPanelProps extends ComponentPropsWithoutRef<"div"> {
  as?: ElementType;
  children: ReactNode;
  /** Adds a hover lift + brighter border - use for clickable/interactive panels. */
  interactive?: boolean;
  /** Slightly stronger surface (nested panels inside another glass panel). */
  raised?: boolean;
  padding?: "none" | "sm" | "md" | "lg";
}

const PADDING: Record<NonNullable<GlassPanelProps["padding"]>, string> = {
  none: "",
  sm: "p-3",
  md: "p-4",
  lg: "p-6",
};

export function GlassPanel({
  as: Tag = "div",
  children,
  interactive = false,
  raised = false,
  padding = "md",
  className,
  ...rest
}: GlassPanelProps) {
  return (
    <Tag
      className={cn(
        "rounded-panel border border-border backdrop-blur-xl transition-all duration-200",
        raised ? "bg-card-hover" : "bg-card/70",
        interactive &&
          "cursor-pointer hover:border-border-strong hover:bg-card-hover hover:-translate-y-0.5 hover:shadow-[0_8px_30px_rgb(0,0,0,0.25)]",
        PADDING[padding],
        className,
      )}
      {...rest}
    >
      {children}
    </Tag>
  );
}
