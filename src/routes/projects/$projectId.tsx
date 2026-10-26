import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, FolderKanban } from "lucide-react";

import { useTRPC } from "#/integrations/trpc/react";
import { PageHeader } from "#/components/PageHeader";
import { StatusBadge } from "#/components/StatusBadge";
import { Button } from "#/components/ui/button";
import { Skeleton } from "#/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "#/components/ui/tabs";
import { ANALYSIS_STATUS_META, meta } from "#/lib/enums";

import { OverviewTab } from "#/components/project/OverviewTab";
import { AnalysisTab } from "#/components/project/AnalysisTab";
import { RequirementsTab } from "#/components/project/RequirementsTab";
import { IncrementalTab } from "#/components/project/IncrementalTab";
import { GenerationTab } from "#/components/project/GenerationTab";
import { CasesPanel } from "#/components/project/CasesPanel";
import { MindmapTab } from "#/components/project/MindmapTab";
import { CoverageTab } from "#/components/project/CoverageTab";
import { ExecutionsPanel } from "#/components/executions/ExecutionsPanel";

const TABS = [
  "overview",
  "analysis",
  "requirements",
  "incremental",
  "generation",
  "cases",
  "mindmap",
  "executions",
  "coverage",
] as const;

type TabId = (typeof TABS)[number];

interface ProjectSearch {
  tab?: TabId;
}

export const Route = createFileRoute("/projects/$projectId")({
  component: ProjectDetailPage,
  validateSearch: (search: Record<string, unknown>): ProjectSearch => ({
    tab: TABS.includes(search.tab as TabId)
      ? (search.tab as TabId)
      : "overview",
  }),
});

function ProjectDetailPage() {
  const { projectId } = Route.useParams();
  const { tab } = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const trpc = useTRPC();

  const { data, isLoading } = useQuery(
    trpc.projects.get.queryOptions({ pid: projectId }),
  );
  const project = data ?? null;

  if (isLoading) {
    return (
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-6">
        <Skeleton className="h-9 w-64" />
        <Skeleton className="h-10 w-full max-w-md rounded-lg" />
        <Skeleton className="h-96 rounded-xl" />
      </div>
    );
  }

  if (!project) {
    return (
      <div className="mx-auto flex w-full max-w-3xl flex-col items-center gap-4 py-20 text-center">
        <FolderKanban className="text-muted-foreground size-10" aria-hidden />
        <h1 className="text-lg font-semibold">Project not found</h1>
        <p className="text-muted-foreground text-sm">
          This project may have been deleted.
        </p>
        <Button
          render={<Link to="/projects" />}
          nativeButton={false}
          variant="outline"
        >
          <ArrowLeft className="size-4" aria-hidden />
          Back to projects
        </Button>
      </div>
    );
  }

  const analysisMeta = meta(ANALYSIS_STATUS_META, project.latestAnalysisStatus);

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-6">
      <div>
        <Button
          render={<Link to="/projects" />}
          nativeButton={false}
          variant="ghost"
          size="sm"
          className="text-muted-foreground mb-2 -ml-2"
        >
          <ArrowLeft className="size-4" aria-hidden />
          Projects
        </Button>
        <PageHeader
          title={
            <span className="flex items-center gap-3">
              {project.name}
              {project.latestAnalysisStatus ? (
                <StatusBadge
                  tone={analysisMeta.tone}
                  label={analysisMeta.label}
                />
              ) : null}
            </span>
          }
          description={project.description || "No description provided."}
        />
      </div>

      <Tabs
        value={tab}
        onValueChange={(value) =>
          navigate({ search: { tab: value as TabId }, replace: true })
        }
      >
        <TabsList className="w-full justify-start overflow-x-auto">
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="analysis">Code analysis</TabsTrigger>
          <TabsTrigger value="requirements">Requirements</TabsTrigger>
          <TabsTrigger value="incremental">Incremental</TabsTrigger>
          <TabsTrigger value="generation">Generation</TabsTrigger>
          <TabsTrigger value="cases">Test cases</TabsTrigger>
          <TabsTrigger value="mindmap">Mindmap</TabsTrigger>
          <TabsTrigger value="executions">Executions</TabsTrigger>
          <TabsTrigger value="coverage">Coverage</TabsTrigger>
        </TabsList>

        <TabsContent value="overview" className="mt-6">
          <OverviewTab project={project} />
        </TabsContent>
        <TabsContent value="analysis" className="mt-6">
          <AnalysisTab projectId={projectId} />
        </TabsContent>
        <TabsContent value="requirements" className="mt-6">
          <RequirementsTab projectId={projectId} />
        </TabsContent>
        <TabsContent value="incremental" className="mt-6">
          <IncrementalTab projectId={projectId} />
        </TabsContent>
        <TabsContent value="generation" className="mt-6">
          <GenerationTab projectId={projectId} />
        </TabsContent>
        <TabsContent value="cases" className="mt-6">
          <CasesPanel projectId={projectId} />
        </TabsContent>
        <TabsContent value="executions" className="mt-6">
          <ExecutionsPanel projectId={projectId} />
        </TabsContent>
        <TabsContent value="mindmap" className="mt-6">
          <MindmapTab projectId={projectId} />
        </TabsContent>
        <TabsContent value="coverage" className="mt-6">
          <CoverageTab projectId={projectId} />
        </TabsContent>
      </Tabs>
    </div>
  );
}
