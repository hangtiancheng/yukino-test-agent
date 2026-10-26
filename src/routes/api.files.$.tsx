import fs from "node:fs";

import { createFileRoute } from "@tanstack/react-router";

// Loads TanStack Start's `server` route-option type augmentation.
import type {} from "@tanstack/react-start";

import { contentTypeFor, resolveOutputPath } from "#/server/lib/files";

const PREFIX = "/api/files/";

async function handler({ request }: { request: Request }) {
  const url = new URL(request.url);
  const idx = url.pathname.indexOf(PREFIX);
  const rel = idx >= 0 ? url.pathname.slice(idx + PREFIX.length) : "";
  const abs = rel ? resolveOutputPath(rel) : null;
  if (!abs || !fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
    return new Response("Not Found", { status: 404 });
  }
  const data = fs.readFileSync(abs);
  return new Response(new Uint8Array(data), {
    headers: {
      "Content-Type": contentTypeFor(abs),
      "Cache-Control": "public, max-age=3600",
    },
  });
}

export const Route = createFileRoute("/api/files/$")({
  server: {
    handlers: {
      GET: handler,
    },
  },
});
