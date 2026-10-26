import { createFileRoute } from "@tanstack/react-router";

// Loads TanStack Start's `server` route-option type augmentation.
import type {} from "@tanstack/react-start";

import {
  buildExecutionReport,
  buildProjectReport,
} from "#/server/services/reports";

const PREFIX = "/api/report/";

async function handler({ request }: { request: Request }) {
  const url = new URL(request.url);
  const idx = url.pathname.indexOf(PREFIX);
  const rest = idx >= 0 ? url.pathname.slice(idx + PREFIX.length) : "";
  const segments = rest.split("/").filter(Boolean).map(decodeURIComponent);
  const kind = segments[0];
  const id = segments[1];
  let html: string;
  if (kind === "project" && id) {
    const requirementId = url.searchParams.get("requirementId");
    const workflowRunId = url.searchParams.get("workflowRunId");
    html = await buildProjectReport(id, { requirementId, workflowRunId });
  } else if (kind === "execution" && id) {
    html = await buildExecutionReport(id);
  } else {
    return new Response("Not Found", { status: 404 });
  }
  return new Response(html, {
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

export const Route = createFileRoute("/api/report/$")({
  server: {
    handlers: {
      GET: handler,
    },
  },
});
