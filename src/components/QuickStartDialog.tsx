import { useEffect, useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { FileText, Upload } from "lucide-react";
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
import { cn } from "#/lib/utils";
import { PRD_ACCEPT, validatePrdFile } from "#/lib/prd";

const URL_RE = /^https?:\/\/[^\s]+$/i;

interface QuickStartFormState {
  name: string;
  sourcePath: string;
  targetUrl: string;
  version: string;
  requirementName: string;
  prdText: string;
}

const EMPTY_FORM: QuickStartFormState = {
  name: "",
  sourcePath: "",
  targetUrl: "http://127.0.0.1:8200",
  version: "V1.0",
  requirementName: "",
  prdText: "",
};

interface QuickStartDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated?: (result: {
    projectId: string;
    requirementId: string | null;
  }) => void;
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result ?? "");
      resolve(result.includes(",") ? result.split(",")[1] : result);
    };
    reader.onerror = () =>
      reject(reader.error ?? new Error("Failed to read file"));
    reader.readAsDataURL(file);
  });
}

/**
 * One-shot bootstrap: creates a project plus a requirement version (with an
 * optional PRD document) and selects the new project, mirroring the legacy
 * quick-start flow.
 */
export function QuickStartDialog({
  open,
  onOpenChange,
  onCreated,
}: QuickStartDialogProps) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [form, setForm] = useState<QuickStartFormState>(EMPTY_FORM);
  const [prdMode, setPrdMode] = useState<"file" | "text">("file");
  const [prdFile, setPrdFile] = useState<File | null>(null);

  function pickPrdFile(file: File | null | undefined) {
    if (!file) return;
    const error = validatePrdFile(file);
    if (error) {
      toast.error(error);
      return;
    }
    setPrdFile(file);
  }

  useEffect(() => {
    if (!open) return;
    setForm(EMPTY_FORM);
    setPrdMode("file");
    setPrdFile(null);
  }, [open]);

  const createProject = useMutation(trpc.projects.create.mutationOptions());
  const createRequirement = useMutation(
    trpc.requirements.create.mutationOptions(),
  );
  const uploadPrd = useMutation(trpc.requirements.uploadPrd.mutationOptions());

  const submitting =
    createProject.isPending ||
    createRequirement.isPending ||
    uploadPrd.isPending;

  function set(key: keyof QuickStartFormState, value: string) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  async function refresh(projectId: string | null) {
    await queryClient.invalidateQueries({
      queryKey: trpc.projects.list.queryKey(),
    });
    if (projectId) {
      await queryClient.invalidateQueries({
        queryKey: trpc.requirements.list.queryKey({ pid: projectId }),
      });
    }
  }

  async function submit() {
    if (!form.name.trim()) return toast.error("Project name is required");
    if (!form.sourcePath.trim()) return toast.error("Source path is required");
    if (form.targetUrl.trim() && !URL_RE.test(form.targetUrl.trim()))
      return toast.error("Target URL must start with http:// or https://");
    if (!form.version.trim()) return toast.error("Version is required");
    if (!form.requirementName.trim())
      return toast.error("Requirement name is required");
    if (prdMode === "text" && !form.prdText.trim())
      return toast.error("Paste the requirement content, or upload a file");
    if (prdMode === "file" && !prdFile)
      return toast.warning("Choose a requirement document, or paste text");

    let projectId: string | null = null;
    let requirementId: string | null = null;
    try {
      const project = await createProject.mutateAsync({
        name: form.name.trim(),
        sourceType: "local_path",
        sourcePath: form.sourcePath.trim(),
        targetUrl: form.targetUrl.trim() || null,
      });
      projectId = project.id;
      const requirement = await createRequirement.mutateAsync({
        pid: project.id,
        name: form.requirementName.trim(),
        version: form.version.trim(),
        content: prdMode === "text" ? form.prdText : "",
      });
      requirementId = requirement.id;
      if (prdMode === "file" && prdFile) {
        await uploadPrd.mutateAsync({
          rid: requirement.id,
          filename: prdFile.name,
          base64: await fileToBase64(prdFile),
        });
      }
      await refresh(projectId);
      toast.success("Project and requirement created");
      onCreated?.({ projectId, requirementId });
      onOpenChange(false);
    } catch (error) {
      if (projectId) {
        await refresh(projectId);
        onCreated?.({ projectId, requirementId });
        toast.warning(
          requirementId
            ? "Project and requirement version created, but the document upload failed. Re-upload it under Requirements."
            : "Project created, but the requirement version failed. Add one under Requirements.",
        );
        onOpenChange(false);
      } else {
        toast.error(
          error instanceof Error ? error.message : "Quick start failed",
        );
      }
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Quick start</DialogTitle>
          <DialogDescription>
            Create a project and a requirement version in one step, then jump
            straight into a pipeline run.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4 py-2">
          <p className="text-muted-foreground text-xs font-semibold tracking-wide uppercase">
            1. Project
          </p>
          <div className="space-y-2">
            <Label htmlFor="qs-name">Name</Label>
            <Input
              id="qs-name"
              value={form.name}
              maxLength={120}
              placeholder="e.g. Order system"
              onChange={(e) => set("name", e.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="qs-source-path">Source path</Label>
            <Input
              id="qs-source-path"
              value={form.sourcePath}
              placeholder="/path/to/project-src"
              onChange={(e) => set("sourcePath", e.target.value)}
            />
            <p className="text-muted-foreground text-xs">
              Code analysis reads this directory on the server machine; Git
              clones and archive extraction are not supported yet.
            </p>
          </div>
          <div className="space-y-2">
            <Label htmlFor="qs-target-url">Target URL</Label>
            <Input
              id="qs-target-url"
              value={form.targetUrl}
              placeholder="http://127.0.0.1:8200"
              onChange={(e) => set("targetUrl", e.target.value)}
            />
          </div>

          <p className="text-muted-foreground mt-2 text-xs font-semibold tracking-wide uppercase">
            2. Requirement document
          </p>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="qs-version">Version</Label>
              <Input
                id="qs-version"
                value={form.version}
                maxLength={40}
                placeholder="V1.0"
                onChange={(e) => set("version", e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="qs-requirement-name">Requirement name</Label>
              <Input
                id="qs-requirement-name"
                value={form.requirementName}
                maxLength={120}
                placeholder="e.g. Order main flow"
                onChange={(e) => set("requirementName", e.target.value)}
              />
            </div>
          </div>

          <div className="space-y-2">
            <Label>Document source</Label>
            <div className="border-border bg-muted/40 inline-flex rounded-lg border p-0.5">
              {(["file", "text"] as const).map((mode) => (
                <button
                  key={mode}
                  type="button"
                  onClick={() => setPrdMode(mode)}
                  className={cn(
                    "rounded-md px-3 py-1 text-sm transition-colors",
                    prdMode === mode
                      ? "bg-background text-foreground font-medium shadow-sm"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {mode === "file" ? "Upload file" : "Paste text"}
                </button>
              ))}
            </div>
          </div>

          {prdMode === "file" ? (
            <div
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault();
                const dropped = e.dataTransfer.files?.[0];
                pickPrdFile(dropped);
              }}
              className="border-border flex flex-col items-center justify-center gap-1.5 rounded-lg border border-dashed px-4 py-6 text-center"
            >
              <Upload className="text-muted-foreground size-5" aria-hidden />
              {prdFile ? (
                <p className="flex items-center gap-1.5 text-sm font-medium">
                  <FileText className="size-4" aria-hidden />
                  {prdFile.name}
                </p>
              ) : (
                <p className="text-muted-foreground text-sm">
                  Drag a document here
                </p>
              )}
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => fileInputRef.current?.click()}
              >
                Choose file
              </Button>
              <p className="text-muted-foreground text-xs">
                Supports .md, .txt, .pdf, .docx
              </p>
              <input
                ref={fileInputRef}
                type="file"
                accept={PRD_ACCEPT}
                className="hidden"
                onChange={(e) => {
                  const chosen = e.target.files?.[0];
                  pickPrdFile(chosen);
                  e.target.value = "";
                }}
              />
            </div>
          ) : (
            <div className="space-y-2">
              <Label htmlFor="qs-prd-text">Requirement content</Label>
              <Textarea
                id="qs-prd-text"
                value={form.prdText}
                rows={7}
                placeholder="Paste the requirement document (Markdown / plain text)"
                onChange={(e) => set("prdText", e.target.value)}
              />
            </div>
          )}

          <div className="bg-muted/50 text-muted-foreground rounded-lg px-3 py-2 text-xs">
            The new project stays selected after creation. Use New run on this
            page to go from code analysis to execution results.
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
          <Button onClick={submit} disabled={submitting}>
            {submitting ? "Creating…" : "Create and continue"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default QuickStartDialog;
