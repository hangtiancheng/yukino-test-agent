# Yukino Test Agent

An AI-driven test platform that turns a codebase and a product requirements
document into structured test cases, runs them in a real browser, and reviews
the evidence with deterministic checks plus an optional vision model.

The platform is built around one principle: **never fake a green result.** A
deterministic execution verdict always wins over an AI opinion, skipped steps
stay honestly skipped, and evidence-driven analysis classifies failures without
overwriting the execution status.

## What it does

- **Static code analysis** — scans a source tree (Spring Boot or Go/yukino_http
  backend; Vue or Lit/lit-jsx frontend) for API
  endpoints, entities, business rules, UI forms, and state machines. These facts
  ground every generated case so selectors and assertions reference real copy.
- **Requirement versions** — attach a PRD (`.md`/`.txt`/`.pdf`/`.docx`) per
  version and extract
  test points from it.
- **Case generation** — deterministic rule-based cases, LLM-generated cases, or
  both (`auto`), validated against the code facts by a quality gate.
- **Browser execution** — runs each case with Playwright, capturing per-step
  screenshots, a video, and structured step records.
- **AI review** — a vision model inspects the screenshots and confirms or
  challenges the result; it can escalate to human review but never turns a
  definite failure into a pass.
- **Pipeline** — a seven-stage workflow (analysis → test points → generation →
  review → execution → result analysis → report) with deterministic review,
  LLM repair rounds, and an evidence-driven failure classification.
- **Coverage & reports** — a planned-vs-executed coverage matrix over endpoints,
  state transitions, and business rules, plus self-contained HTML reports.

## Tech stack

| Layer      | Choice                                                          |
| ---------- | --------------------------------------------------------------- |
| Framework  | [TanStack Start](https://tanstack.com/start) (SSR, Vite, Nitro) |
| Routing    | TanStack Router (file-based, type-safe)                         |
| Data       | TanStack Query + tRPC v11 (end-to-end types, superjson)         |
| Database   | PostgreSQL via Drizzle ORM                                      |
| Styling    | Tailwind CSS v4 + shadcn/ui (new-york, zinc)                    |
| Validation | Zod                                                             |
| Icons      | lucide-react                                                    |
| Browser    | Playwright                                                      |
| Toasts     | sonner                                                          |

## Getting started

### Prerequisites

- Node.js 20+ (developed on Node 24)
- pnpm 9+
- PostgreSQL 14+
- Playwright browsers: `pnpm exec playwright install chromium`

### 1. Install

```bash
pnpm install
```

### 2. Configure environment

Copy the example env file and point it at your database:

```bash
cp .env.example .env.local
```

| Variable             | Purpose                                                                                                                             |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`       | PostgreSQL connection string used by Drizzle (server-side).                                                                         |
| `OUTPUT_DIR`         | Where execution evidence (screenshots, videos, reports) is written.                                                                 |
| `TARGET_URL_DEFAULT` | Default URL of the system under test (the demo site uses `http://127.0.0.1:8200`).                                                  |
| `LLM_*`              | Optional initial text-model config; migrated into the default profile on first settings read. Leave empty to run in pure rule mode. |
| `LLM_VISION_*`       | Optional vision-model config; falls back to the text profile.                                                                       |

LLM profiles can also be created at runtime under **Settings**, which take
precedence over the environment values when marked default.

### 3. Create the database schema

```bash
pnpm db:push
```

This applies the 20-table schema in `src/db/schema.ts`. Use `pnpm db:studio` to
inspect it, or `pnpm db:generate` / `pnpm db:migrate` for migration files.

### 4. Run the app

```bash
pnpm dev
```

Open http://localhost:3000.

### 5. (Optional) Run the demo target site

The bundled demo is a small English order-management app used as the system
under test. Its visible copy matches the anchors the generator produces.

```bash
pnpm demo-site   # serves http://127.0.0.1:8200
```

Then create a project with **Target URL** `http://127.0.0.1:8200`, attach a PRD,
and run the pipeline.

## Scripts

| Script                 | Description                                                                                            |
| ---------------------- | ------------------------------------------------------------------------------------------------------ |
| `pnpm dev`             | Start the dev server on port 3000.                                                                     |
| `pnpm build`           | Production build (Vite + Nitro output in `.output`).                                                   |
| `pnpm start`           | Run the production build.                                                                              |
| `pnpm preview`         | Preview the production build.                                                                          |
| `pnpm demo-site`       | Serve the demo target site on port 8200.                                                               |
| `pnpm e2e`             | End-to-end self check: analyze the bundled sample, generate cases, execute them against the demo site. |
| `pnpm generate-routes` | Regenerate the TanStack Router route tree.                                                             |
| `pnpm lint`            | ESLint.                                                                                                |
| `pnpm format`          | Prettier write + ESLint fix.                                                                           |
| `pnpm check`           | Prettier format check.                                                                                 |
| `pnpm db:push`         | Push the Drizzle schema to the database.                                                               |
| `pnpm db:studio`       | Open Drizzle Studio.                                                                                   |

There is no dedicated `typecheck` script; run `pnpm exec tsc --noEmit`.

## Architecture

```
src/
  db/schema.ts            20 Drizzle tables (projects, requirements, cases,
                          executions, reviews, workflow runs/stages, profiles…)
  lib/
    types.ts              shared domain contracts (steps, facts, results)
    enums.ts              status codes + English display metadata (single source
                          of truth for labels/tones used by UI and reports)
    format.ts             date/duration/percent helpers
  server/
    env.ts                validated server environment
    lib/
      analyzer/           static analysis (scanner, spring, vue, state-machine)
      generation/         rule cases, LLM cases, test points, quality gate,
                          count-assertion normalization, prompts
      execution/          Playwright runner + vision review
      llm.ts jobs.ts      LLM client and in-process job runner
      files.ts            evidence path <-> /api/files URL helpers
      mindmap.ts          case-set tree + markdown export
      coverage.ts         planned-vs-executed coverage matrix
    services/             projects, analysis, requirements, testcases,
                          generation, executions, workflows, stats, coverage,
                          reports, settings
  integrations/trpc/      tRPC init (BizError -> TRPCError), router, react proxy
  routes/                 file-based routes (see below)
  components/             app shell + shadcn ui primitives + feature panels
  hooks/                  use-job-poller, use-theme
scripts/demo-site/        English order-system target site (Node static server)
```

### Routes

| Route                                | Purpose                                                                                                                |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------- |
| `/dashboard`                         | Platform-wide stats and recent activity.                                                                               |
| `/projects`                          | Project list, create/edit/delete.                                                                                      |
| `/projects/$projectId`               | Project detail with tabs (search param `tab`): overview, analysis, requirements, generation, cases, mindmap, coverage. |
| `/projects/$projectId/cases/$caseId` | Case detail, structured steps, history, versions.                                                                      |
| `/testcases`                         | Project-scoped case browser (picker + `pid`).                                                                          |
| `/pipeline`                          | Workflow runs for a project + create run.                                                                              |
| `/pipeline/$runId`                   | Run detail: stage timeline and per-case review.                                                                        |
| `/executions`                        | Project-scoped execution list.                                                                                         |
| `/executions/$executionId`           | Execution detail: steps, screenshots, video, AI review, manual verdict.                                                |
| `/settings`                          | LLM profiles (text/vision) and environment info.                                                                       |
| `/api/trpc/$`                        | tRPC HTTP handler.                                                                                                     |
| `/api/files/$`                       | Serves evidence files from `OUTPUT_DIR`.                                                                               |
| `/api/report/$`                      | Serves generated HTML reports.                                                                                         |

### Pipeline stages

1. **Code analysis** — refresh static facts (optional).
2. **Test points** — extract scenarios from the requirement PRD.
3. **Case generation** — rule and/or LLM cases grounded in the facts.
4. **Case review** — deterministic quality gate, then LLM review with up to two
   repair rounds; blocking issues reject a case, fixable issues trigger repair.
5. **Execution** — run approved cases in Playwright.
6. **Result analysis** — evidence-driven failure classification (product defect,
   script issue, data issue, environment, unknown); never overwrites the
   execution status.
7. **Report** — a self-contained HTML summary.

## Conventions

- **Anchors** — expected results quote visible page copy with double quotes,
  e.g. `"Order created successfully"`. Selectors and anchors use the exact copy
  from the code facts; prose (titles, descriptions) stays English.
- **Statuses** — the database stores stable English codes; `src/lib/enums.ts`
  maps each code to a label, tone, and description for the UI and reports.
- **IDs** — cases are `TC-000001`-style sequences, executions are `EX-…`,
  internal keys are dashless UUID hex.
- **PRD uploads** — `.md`/`.txt`/`.pdf`/`.docx` (PDF via `unpdf`, DOCX via
  `mammoth`).
- **Errors** — services throw `BizError(code, message)`; the tRPC layer maps
  `404xx` to `NOT_FOUND` and everything else to `BAD_REQUEST`.

## Notes

- The custom theme system applies a `.dark`/`.light` class on `<html>` and
  persists the choice (`light`/`dark`/`auto`) in `localStorage`; an inline
  script in the document shell prevents a flash on first paint.
- Evidence paths are stored absolute on disk and converted to `/api/files/...`
  URLs at the read boundary, so the browser never sees server filesystem paths.
- `pnpm lint` uses the strict TanStack ESLint config. The migrated UI, hooks,
  routes, and shared libs are clean; some pre-existing server modules still trip
  `@typescript-eslint/no-unnecessary-condition` on intentional defensive guards.
