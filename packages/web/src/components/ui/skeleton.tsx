import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";

/**
 * Placeholder that occupies the same box as the content it stands in for, so nothing
 * shifts when the data lands.
 */
export function Skeleton({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      aria-hidden
      className={cn("animate-pulse rounded-md bg-[var(--color-surface-2)]", className)}
      {...props}
    />
  );
}
