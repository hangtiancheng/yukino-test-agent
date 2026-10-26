# Sample Source (analysis fixture)

A minimal order-management system used as the built-in fixture for static
analysis (`scripts/e2e.mts` points a throwaway project at this directory).

- **Backend** — Go + [yukino_http](https://github.com/hangtiancheng/yukino.go/tree/main/libs/yukino_http).
  `handler.go` registers the `/api/orders` endpoints, `order.go` holds the
  entity and its validation messages, `status.go` the lifecycle enum and
  labels, and `service.go` the guarded state transitions.
- **Frontend** — Lit + `@yukino.js/lit-jsx` (JSX) + Tailwind CSS v4, built
  with Vite. `src/router.tsx` is the route table, `src/views/*` are the
  pages, and `src/components/text-field.tsx` carries the `label` / `prop` /
  `placeholder` attributes the analyzer extracts as form fields. Components
  render into light DOM (`createRenderRoot` returns the host) so the global
  Tailwind sheet in `src/styles.css` styles them. Because the published
  `@yukino.js/lit-jsx@0.0.1` has no `community` entry point, `src/app-router.tsx`
  vendors a minimal history-mode router (`createBrowserRouter`, `navigate`,
  `<route-view>`) with the same route-table shape.

## Contract with the pipeline

The visible copy here (labels, placeholders, validation messages, success
toasts, status labels, button texts) intentionally matches the bundled demo
target site (`scripts/demo-site`) one-for-one. Generated cases anchor their
assertions on this exact copy, so renaming any string breaks the e2e run.

The Go backend is functional: `cd scripts/sample-src && go run .` serves the
API on `:8080`. The frontend builds and runs as well — from the repo root,
`pnpm --filter order-demo-frontend dev` serves it on `:5173` (`build` and
`typecheck` scripts exist too) — but it mirrors the backend rules
client-side and never calls the API; the pipeline consumes it purely as a
static-analysis fixture.
