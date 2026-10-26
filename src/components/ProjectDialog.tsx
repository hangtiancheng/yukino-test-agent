import { useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { useTRPC } from "#/integrations/trpc/react";
import { Button } from "#/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "#/components/ui/dialog";
import { Input } from "#/components/ui/input";
import { Label } from "#/components/ui/label";
import { Textarea } from "#/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "#/components/ui/select";

import type { ProjectDict } from "#/server/services/projects";

interface ProjectFormState {
  name: string;
  description: string;
  sourceType: "local_path" | "git";
  sourcePath: string;
  gitUrl: string;
  gitBranch: string;
  targetUrl: string;
}

const EMPTY_FORM: ProjectFormState = {
  name: "",
  description: "",
  sourceType: "local_path",
  sourcePath: "",
  gitUrl: "",
  gitBranch: "main",
  targetUrl: "",
};

interface ProjectDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  project?: ProjectDict | null;
}

export function ProjectDialog({
  open,
  onOpenChange,
  project,
}: ProjectDialogProps) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const isEdit = Boolean(project?.id);
  const [form, setForm] = useState<ProjectFormState>(EMPTY_FORM);

  useEffect(() => {
    if (!open) return;
    if (project) {
      setForm({
        name: project.name,
        description: project.description ?? "",
        sourceType: project.sourceType === "git" ? "git" : "local_path",
        sourcePath: project.sourcePath ?? "",
        gitUrl: project.gitUrl ?? "",
        gitBranch: project.gitBranch ?? "main",
        targetUrl: project.targetUrl ?? "",
      });
    } else {
      setForm(EMPTY_FORM);
    }
  }, [open, project]);

  function set<T extends keyof ProjectFormState>(
    key: T,
    value: ProjectFormState[T],
  ) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: trpc.projects.list.queryKey() });

  const createMutation = useMutation(
    trpc.projects.create.mutationOptions({
      onSuccess: async () => {
        toast.success("Project created");
        await invalidate();
        onOpenChange(false);
      },
      onError: (error) => toast.error(error.message),
    }),
  );
  const updateMutation = useMutation(
    trpc.projects.update.mutationOptions({
      onSuccess: async () => {
        toast.success("Project updated");
        await invalidate();
        onOpenChange(false);
      },
      onError: (error) => toast.error(error.message),
    }),
  );

  const submitting = createMutation.isPending || updateMutation.isPending;
  const nameValid = form.name.trim().length > 0;

  function onSubmit() {
    if (!nameValid) {
      toast.error("Project name is required");
      return;
    }
    const payload = {
      name: form.name.trim(),
      description: form.description.trim() || null,
      sourceType: form.sourceType,
      sourcePath:
        form.sourceType === "local_path"
          ? form.sourcePath.trim() || null
          : null,
      gitUrl: form.sourceType === "git" ? form.gitUrl.trim() || null : null,
      gitBranch:
        form.sourceType === "git" ? form.gitBranch.trim() || "main" : null,
      targetUrl: form.targetUrl.trim() || null,
    };
    if (isEdit && project) {
      updateMutation.mutate({ pid: project.id, ...payload });
    } else {
      createMutation.mutate(payload);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{isEdit ? "Edit project" : "New project"}</DialogTitle>
          <DialogDescription>
            {isEdit
              ? "Update the project metadata and source location."
              : "Point the platform at a codebase to analyze and a running app to test."}
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4 py-2">
          <div className="space-y-2">
            <Label htmlFor="project-name">Name</Label>
            <Input
              id="project-name"
              value={form.name}
              maxLength={120}
              placeholder="Orders demo"
              onChange={(e) => set("name", e.target.value)}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="project-description">Description</Label>
            <Textarea
              id="project-description"
              value={form.description}
              maxLength={500}
              rows={2}
              placeholder="What does this system do?"
              onChange={(e) => set("description", e.target.value)}
            />
          </div>

          <div className="space-y-2">
            <Label>Source type</Label>
            <Select
              value={form.sourceType}
              onValueChange={(value) =>
                set("sourceType", value as ProjectFormState["sourceType"])
              }
            >
              <SelectTrigger className="w-full">
                <SelectValue placeholder="Select a source type" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="local_path">Local path</SelectItem>
                <SelectItem value="git">Git repository</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {form.sourceType === "local_path" ? (
            <div className="space-y-2">
              <Label htmlFor="project-source-path">Source path</Label>
              <Input
                id="project-source-path"
                value={form.sourcePath}
                placeholder="/path/to/project-src"
                onChange={(e) => set("sourcePath", e.target.value)}
              />
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
              <div className="space-y-2 sm:col-span-2">
                <Label htmlFor="project-git-url">Git URL</Label>
                <Input
                  id="project-git-url"
                  value={form.gitUrl}
                  placeholder="https://github.com/org/repo.git"
                  onChange={(e) => set("gitUrl", e.target.value)}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="project-git-branch">Branch</Label>
                <Input
                  id="project-git-branch"
                  value={form.gitBranch}
                  placeholder="main"
                  onChange={(e) => set("gitBranch", e.target.value)}
                />
              </div>
            </div>
          )}

          <div className="space-y-2">
            <Label htmlFor="project-target-url">Target URL</Label>
            <Input
              id="project-target-url"
              value={form.targetUrl}
              placeholder="http://127.0.0.1:8200"
              onChange={(e) => set("targetUrl", e.target.value)}
            />
            <p className="text-muted-foreground text-xs">
              The running application the browser will test. Leave empty to use
              the server default.
            </p>
          </div>
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={submitting}
          >
            Cancel
          </Button>
          <Button onClick={onSubmit} disabled={submitting || !nameValid}>
            {submitting
              ? "Saving…"
              : isEdit
                ? "Save changes"
                : "Create project"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default ProjectDialog;
