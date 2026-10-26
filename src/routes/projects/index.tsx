import { useMemo, useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  FolderKanban,
  GitBranch,
  HardDrive,
  MoreHorizontal,
  Pencil,
  Plus,
  Search,
  Trash2,
} from "lucide-react";

import { useTRPC } from "#/integrations/trpc/react";
import { PageHeader } from "#/components/PageHeader";
import { EmptyState } from "#/components/EmptyState";
import { StatusBadge } from "#/components/StatusBadge";
import { ProjectDialog } from "#/components/ProjectDialog";
import { Button } from "#/components/ui/button";
import { Card, CardContent } from "#/components/ui/card";
import { Input } from "#/components/ui/input";
import { Skeleton } from "#/components/ui/skeleton";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "#/components/ui/dropdown-menu";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "#/components/ui/alert-dialog";
import { ANALYSIS_STATUS_META, meta } from "#/lib/enums";
import { timeAgo } from "#/lib/format";

import type { ProjectDict } from "#/server/services/projects";

export const Route = createFileRoute("/projects/")({
  component: ProjectsPage,
});

function ProjectsPage() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const [keyword, setKeyword] = useState("");
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<ProjectDict | null>(null);
  const [deleting, setDeleting] = useState<ProjectDict | null>(null);

  const { data, isLoading } = useQuery(trpc.projects.list.queryOptions());
  const projects = data ?? [];

  const filtered = useMemo(() => {
    const term = keyword.trim().toLowerCase();
    if (!term) return projects;
    return projects.filter(
      (p) =>
        p.name.toLowerCase().includes(term) ||
        (p.description ?? "").toLowerCase().includes(term),
    );
  }, [projects, keyword]);

  const deleteMutation = useMutation(
    trpc.projects.delete.mutationOptions({
      onSuccess: async () => {
        toast.success("Project deleted");
        setDeleting(null);
        await queryClient.invalidateQueries({
          queryKey: trpc.projects.list.queryKey(),
        });
      },
      onError: (error) => toast.error(error.message),
    }),
  );

  function openCreate() {
    setEditing(null);
    setDialogOpen(true);
  }
  function openEdit(project: ProjectDict) {
    setEditing(project);
    setDialogOpen(true);
  }

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-6">
      <PageHeader
        title="Projects"
        description="Each project points at a codebase to analyze and a running app to test."
        actions={
          <Button onClick={openCreate}>
            <Plus className="size-4" aria-hidden />
            New project
          </Button>
        }
      />

      <div className="relative max-w-sm">
        <Search
          className="text-muted-foreground pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2"
          aria-hidden
        />
        <Input
          value={keyword}
          placeholder="Search projects…"
          className="pl-9"
          onChange={(e) => setKeyword(e.target.value)}
        />
      </div>

      {isLoading ? (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-44 rounded-xl" />
          ))}
        </div>
      ) : filtered.length === 0 ? (
        <EmptyState
          icon={FolderKanban}
          title={
            projects.length === 0 ? "No projects yet" : "No matching projects"
          }
          description={
            projects.length === 0
              ? "Create your first project to start analyzing code and generating test cases."
              : "Try a different search term."
          }
          action={
            projects.length === 0 ? (
              <Button onClick={openCreate}>
                <Plus className="size-4" aria-hidden />
                New project
              </Button>
            ) : undefined
          }
        />
      ) : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
          {filtered.map((project) => (
            <ProjectCard
              key={project.id}
              project={project}
              onEdit={() => openEdit(project)}
              onDelete={() => setDeleting(project)}
            />
          ))}
        </div>
      )}

      <ProjectDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        project={editing}
      />

      <AlertDialog
        open={Boolean(deleting)}
        onOpenChange={(open) => {
          if (!open) setDeleting(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete project?</AlertDialogTitle>
            <AlertDialogDescription>
              This permanently removes “{deleting?.name}” along with its
              requirements, test cases, and execution history. This action
              cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() =>
                deleting && deleteMutation.mutate({ pid: deleting.id })
              }
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {deleteMutation.isPending ? "Deleting…" : "Delete"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function ProjectCard({
  project,
  onEdit,
  onDelete,
}: {
  project: ProjectDict;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const analysisMeta = meta(ANALYSIS_STATUS_META, project.latestAnalysisStatus);
  const isGit = project.sourceType === "git";
  const sourceValue = isGit ? project.gitUrl : project.sourcePath;

  return (
    <Card className="group hover:border-primary/40 relative flex flex-col transition-colors">
      <CardContent className="flex flex-1 flex-col gap-3 p-5">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <Link
              to="/projects/$projectId"
              params={{ projectId: project.id }}
              className="block truncate text-base font-semibold tracking-tight hover:underline"
            >
              {project.name}
            </Link>
            <p className="text-muted-foreground mt-1 line-clamp-2 min-h-8 text-sm">
              {project.description || "No description"}
            </p>
          </div>
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon"
                  className="text-muted-foreground size-8 shrink-0 opacity-0 transition-opacity group-hover:opacity-100 focus:opacity-100"
                  aria-label="Project actions"
                />
              }
            >
              <MoreHorizontal className="size-4" aria-hidden />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={onEdit}>
                <Pencil className="size-4" aria-hidden />
                Edit
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={onDelete}
                className="text-destructive focus:text-destructive"
              >
                <Trash2 className="size-4" aria-hidden />
                Delete
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>

        <div className="text-muted-foreground flex items-center gap-2 text-xs">
          {isGit ? (
            <GitBranch className="size-3.5 shrink-0" aria-hidden />
          ) : (
            <HardDrive className="size-3.5 shrink-0" aria-hidden />
          )}
          <span className="truncate" title={sourceValue ?? undefined}>
            {sourceValue || "No source configured"}
          </span>
        </div>

        <div className="border-border/60 mt-auto flex items-center justify-between border-t pt-3">
          <div className="text-muted-foreground flex items-center gap-3 text-xs">
            <span>
              <span className="text-foreground font-medium">
                {project.caseCount ?? 0}
              </span>{" "}
              cases
            </span>
            <span>
              <span className="text-foreground font-medium">
                {project.requirementCount ?? 0}
              </span>{" "}
              requirements
            </span>
          </div>
          {project.latestAnalysisStatus ? (
            <StatusBadge tone={analysisMeta.tone} label={analysisMeta.label} />
          ) : (
            <span className="text-muted-foreground text-xs">
              Updated {timeAgo(project.updatedAt)}
            </span>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
