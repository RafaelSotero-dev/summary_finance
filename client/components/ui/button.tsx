import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import { type ButtonHTMLAttributes, forwardRef } from "react";
import { cn } from "../../lib/utils";

const buttonVariants = cva(
  "inline-flex items-center justify-center rounded-md px-4 py-2 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-500 disabled:pointer-events-none disabled:opacity-50",
  { variants: { variant: { default: "bg-slate-900 text-white hover:bg-slate-700", secondary: "border border-slate-300 bg-white text-slate-900 hover:bg-slate-100" } }, defaultVariants: { variant: "default" } },
);

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(({ asChild, className, variant, ...props }, ref) => {
  const Component = asChild ? Slot : "button";
  return <Component className={cn(buttonVariants({ variant }), className)} ref={ref} {...props} />;
});
Button.displayName = "Button";
