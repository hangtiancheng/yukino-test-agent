import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import { trpcRouter } from "#/integrations/trpc/router";
import { createFileRoute } from "@tanstack/react-router";

// Loads TanStack Start's `server` route-option type augmentation.
import type {} from "@tanstack/react-start";

import { ensureRecovered } from "#/server/bootstrap";

function handler({ request }: { request: Request }) {
  ensureRecovered();
  return fetchRequestHandler({
    req: request,
    router: trpcRouter,
    endpoint: "/api/trpc",
  });
}

export const Route = createFileRoute("/api/trpc/$")({
  server: {
    handlers: {
      GET: handler,
      POST: handler,
    },
  },
});
