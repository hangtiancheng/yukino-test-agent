import { Badge } from "#/components/ui/badge";
import { cn } from "#/lib/utils";

import type { Tone } from "#/lib/enums";
import type { ComponentProps } from "react";

const TONE_CLASS: Record<string, string> = {
  success: "border-success/25 bg-success/12 text-success",
  danger: "border-destructive/25 bg-destructive/12 text-destructive",
  warning: "border-warning/30 bg-warning/15 text-warning",
  info: "border-info/25 bg-info/12 text-info",
  primary: "border-primary/25 bg-primary/10 text-primary",
};

const DOT_CLASS: Record<string, string> = {
  success: "bg-success",
  danger: "bg-destructive",
  warning: "bg-warning",
  info: "bg-info",
  primary: "bg-primary",
};

interface StatusBadgeProps extends Omit<
  ComponentProps<typeof Badge>,
  "variant"
> {
  tone?: Tone | string | null;
  label?: string | null;
  dot?: boolean;
  pulse?: boolean;
}

/**
 * Renders an enum code as a colored pill using the shared tone vocabulary.
 * Pass `label` to override the display text (otherwise `children` is used).
 */
export function StatusBadge({
  tone = "info",
  label,
  children,
  dot = false,
  pulse = false,
  className,
  ...props
}: StatusBadgeProps) {
  const resolved = (tone ?? "info") as Tone;
  const toneClass = TONE_CLASS[resolved] ?? TONE_CLASS.info;
  const text = label ?? children ?? "";
  return (
    <Badge
      variant="outline"
      className={cn("gap-1.5 font-medium tracking-tight", toneClass, className)}
      {...props}
    >
      {dot ? (
        <span className="relative flex size-1.5">
          {pulse ? (
            <span
              className={cn(
                "absolute inline-flex h-full w-full animate-ping rounded-full opacity-75",
                DOT_CLASS[resolved] ?? DOT_CLASS.info,
              )}
            />
          ) : null}
          <span
            className={cn(
              "relative inline-flex size-1.5 rounded-full",
              DOT_CLASS[resolved] ?? DOT_CLASS.info,
            )}
          />
        </span>
      ) : null}
      {text}
    </Badge>
  );
}

export default StatusBadge;
