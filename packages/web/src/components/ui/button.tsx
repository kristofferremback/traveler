import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const buttonVariants = cva(
  // min-h-11 keeps every button at a 44px touch target, which is the floor for a
  // control someone taps while walking.
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-lg text-sm font-medium transition-colors disabled:pointer-events-none disabled:opacity-50 [&_svg]:size-4 [&_svg]:shrink-0 min-h-11",
  {
    variants: {
      variant: {
        default: "bg-[var(--color-accent)] text-[var(--color-bg)] hover:opacity-90",
        secondary:
          "bg-[var(--color-surface-2)] text-[var(--color-fg)] hover:bg-[var(--color-border)]",
        outline:
          "border border-[var(--color-border)] bg-transparent hover:bg-[var(--color-surface-2)]",
        ghost: "hover:bg-[var(--color-surface-2)]",
        danger: "bg-[var(--color-danger)] text-white hover:opacity-90",
      },
      size: {
        default: "px-4 py-2",
        // Still 44px tall. A small button is visually lighter, not harder to hit.
        sm: "px-3 py-1.5 text-xs min-h-11",
        lg: "px-6 py-3 text-base",
        icon: "size-11",
      },
    },
    defaultVariants: { variant: "default", size: "default" },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : "button";
    return (
      <Comp
        ref={ref}
        className={cn(buttonVariants({ variant, size }), className)}
        {...props}
      />
    );
  },
);
Button.displayName = "Button";

export { buttonVariants };
