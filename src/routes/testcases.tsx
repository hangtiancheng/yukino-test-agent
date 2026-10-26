import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { ListChecks } from "lucide-react";

import { PageHeader } from "#/components/PageHeader";
import { EmptyState } from "#/components/EmptyState";
import { ProjectPicker } from "#/components/ProjectPicker";
import { CasesPanel } from "#/components/project/CasesPanel";

interface TestcasesSearch {
  pid?: string;
}

export const Route = createFileRoute("/testcases")({
  component: TestcasesPage,
  validateSearch: (search: Record<string, unknown>): TestcasesSearch => ({
    pid: typeof search.pid === "string" ? search.pid : undefined,
  }),
});

function TestcasesPage() {
  const { pid } = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-6">
      <PageHeader
        title="Test Cases"
        description="Browse, filter, run, and manage the cases generated for a project."
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
        <CasesPanel key={pid} projectId={pid} />
      ) : (
        <EmptyState
          icon={ListChecks}
          title="Choose a project"
          description="Select a project to browse and run its test cases."
        />
      )}
    </div>
  );
}
