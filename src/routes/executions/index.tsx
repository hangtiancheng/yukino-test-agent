import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { PlayCircle } from "lucide-react";

import { PageHeader } from "#/components/PageHeader";
import { EmptyState } from "#/components/EmptyState";
import { ProjectPicker } from "#/components/ProjectPicker";
import { ExecutionsPanel } from "#/components/executions/ExecutionsPanel";

interface ExecutionsSearch {
  pid?: string;
}

export const Route = createFileRoute("/executions/")({
  component: ExecutionsPage,
  validateSearch: (search: Record<string, unknown>): ExecutionsSearch => ({
    pid: typeof search.pid === "string" ? search.pid : undefined,
  }),
});

function ExecutionsPage() {
  const { pid } = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-6">
      <PageHeader
        title="Executions"
        description="Every recorded browser run, with its verdict, steps, and evidence."
        actions={
          <ProjectPicker
            value={pid ?? null}
            onChange={(projectId) =>
              navigate({ search: { pid: projectId }, replace: true })
            }
          />
        }
      />

      {pid ? (
        <ExecutionsPanel key={pid} projectId={pid} />
      ) : (
        <EmptyState
          icon={PlayCircle}
          title="Choose a project"
          description="Select a project to browse its recorded executions."
        />
      )}
    </div>
  );
}
