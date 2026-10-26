import { useState } from "react";
import { ImageIcon } from "lucide-react";

import { cn } from "#/lib/utils";

import type { ReviewIssue } from "#/lib/types";

interface ScreenshotViewerProps {
  src: string | null;
  alt?: string;
  /** Normalized [x1, y1, x2, y2] in 0..1 to highlight. */
  bbox?: ReviewIssue["bbox"] | null;
  className?: string;
}

/**
 * Renders an execution screenshot with an optional highlighted bounding box.
 * Evidence URLs are already converted to `/api/files/...` by the server.
 */
export function ScreenshotViewer({
  src,
  alt,
  bbox,
  className,
}: ScreenshotViewerProps) {
  const [failed, setFailed] = useState(false);

  if (!src || failed) {
    return (
      <div
        className={cn(
          "border-border bg-muted/40 text-muted-foreground flex aspect-video items-center justify-center rounded-lg border border-dashed",
          className,
        )}
      >
        <div className="flex flex-col items-center gap-1 text-xs">
          <ImageIcon className="size-5" aria-hidden />
          <span>No screenshot</span>
        </div>
      </div>
    );
  }

  const box = bbox
    ? {
        left: `${bbox[0] * 100}%`,
        top: `${bbox[1] * 100}%`,
        width: `${Math.max(0, bbox[2] - bbox[0]) * 100}%`,
        height: `${Math.max(0, bbox[3] - bbox[1]) * 100}%`,
      }
    : null;

  return (
    <div
      className={cn(
        "border-border/60 bg-muted relative overflow-hidden rounded-lg border",
        className,
      )}
    >
      <img
        src={src}
        alt={alt ?? "Execution screenshot"}
        className="block h-auto w-full object-contain"
        loading="lazy"
        onError={() => setFailed(true)}
      />
      {box ? (
        <div
          className="border-destructive bg-destructive/15 pointer-events-none absolute rounded-sm border-2 shadow-[0_0_0_1px_rgba(0,0,0,0.2)]"
          style={box}
          aria-hidden
        />
      ) : null}
    </div>
  );
}

export default ScreenshotViewer;
