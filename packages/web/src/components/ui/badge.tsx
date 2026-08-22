import { cva, type VariantProps } from "class-variance-authority";
import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";

const badgeVariants = cva(
  "inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-xs font-medium",
  {
    variants: {
      variant: {
        default: "bg-[var(--color-surface-2)] text-[var(--color-fg)]",
        outline: "border border-[var(--color-border)]",
        ok: "bg-[var(--color-ok)]/15 text-[var(--color-ok)]",
        warn: "bg-[var(--color-warn)]/15 text-[var(--color-warn)]",
        danger: "bg-[var(--color-danger)]/15 text-[var(--color-danger)]",
      },
    },
    defaultVariants: { variant: "default" },
  },
);

export function Badge({
  className,
  variant,
  ...props
}: ComponentProps<"span"> & VariantProps<typeof badgeVariants>) {
  return <span className={cn(badgeVariants({ variant }), className)} {...props} />;
}
