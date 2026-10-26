import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { FileText, GitBranch, Globe, HardDrive, Upload } from "lucide-react";

import { useTRPC } from "#/integrations/trpc/react";
import { StatusBadge } from "#/components/StatusBadge";
import { Button } from "#/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "#/components/ui/card";
import { Textarea } from "#/components/ui/textarea";
import { Separator } from "#/components/ui/separator";
import { Skeleton } from "#/components/ui/skeleton";
import { formatDate } from "#/lib/format";
import { cn } from "#/lib/utils";
import { PRD_ACCEPT, validatePrdFile } from "#/lib/prd";

import type { ProjectDict } from "#/server/services/projects";

export function OverviewTab({ project }: { project: ProjectDict }) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const { data, isLoading } = useQuery(
    trpc.projects.prd.queryOptions({ pid: project.id }),
  );
  const [content, setContent] = useState("");
  const [dirty, setDirty] = useState(false);
  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    if (data) {
      setContent(data.content);
      setDirty(false);
    }
  }, [data]);

  const saveMutation = useMutation(
    trpc.projects.updatePrd.mutationOptions({
      onSuccess: () => {
        toast.success("PRD saved");
        setDirty(false);
        queryClient.invalidateQueries({
          queryKey: trpc.projects.prd.queryKey(),
        });
      },
      onError: (error) => toast.error(error.message),
    }),
  );
  const uploadMutation = useMutation(
    trpc.projects.uploadPrd.mutationOptions({
      onSuccess: () => {
        toast.success("PRD uploaded");
        queryClient.invalidateQueries({
          queryKey: trpc.projects.prd.queryKey(),
        });
      },
      onError: (error) => toast.error(error.message),
    }),
  );

  function onUploadFile(file: File) {
    const error = validatePrdFile(file);
    if (error) {
      toast.error(error);
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result ?? "");
      const base64 = result.includes(",") ? result.split(",")[1] : result;
      uploadMutation.mutate({ pid: project.id, filename: file.name, base64 });
    };
    reader.onerror = () =>
      toast.error(reader.error?.message ?? "Failed to read the file");
    reader.readAsDataURL(file);
  }

  const isGit = project.sourceType === "git";
  const techStack = project.techStack ?? {};

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
      <Card className="lg:col-span-1">
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Project details</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4 text-sm">
          <DetailRow
            icon={isGit ? GitBranch : HardDrive}
            label={isGit ? "Git repository" : "Local path"}
            value={
              isGit
                ? `${project.gitUrl ?? "—"}${project.gitBranch ? ` @ ${project.gitBranch}` : ""}`
                : (project.sourcePath ?? "—")
            }
          />
          <DetailRow
            icon={Globe}
            label="Target URL"
            value={project.targetUrl ?? "—"}
          />
          <DetailRow
            icon={FileText}
            label="PRD"
            value={project.hasPrd ? "Attached" : "Not attached"}
          />
          <Separator />
          <div className="flex flex-col gap-1">
            <span className="text-muted-foreground text-xs">Created</span>
            <span>{formatDate(project.createdAt)}</span>
          </div>
          <div className="flex flex-col gap-1">
            <span className="text-muted-foreground text-xs">Last updated</span>
            <span>{formatDate(project.updatedAt)}</span>
          </div>
          {Object.keys(techStack).length > 0 ? (
            <>
              <Separator />
              <div className="flex flex-col gap-2">
                <span className="text-muted-foreground text-xs">
                  Detected tech stack
                </span>
                <div className="flex flex-wrap gap-1.5">
                  {Object.entries(techStack).map(([key, value]) => (
                    <StatusBadge
                      key={key}
                      tone="info"
                      label={`${key}${value ? `: ${value}` : ""}`}
                    />
                  ))}
                </div>
              </div>
            </>
          ) : null}
        </CardContent>
      </Card>

      <Card className="lg:col-span-2">
        <CardHeader className="flex-row items-center justify-between space-y-0 pb-3">
          <CardTitle className="text-base">
            Product requirements (PRD)
          </CardTitle>
          <div className="flex items-center gap-2">
            <input
              ref={fileInputRef}
              type="file"
              accept={PRD_ACCEPT}
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) onUploadFile(file);
                e.target.value = "";
              }}
            />
            <Button
              variant="outline"
              size="sm"
              onClick={() => fileInputRef.current?.click()}
              disabled={uploadMutation.isPending}
            >
              <Upload className="size-4" aria-hidden />
              Upload document
            </Button>
            <Button
              size="sm"
              onClick={() => saveMutation.mutate({ pid: project.id, content })}
              disabled={!dirty || saveMutation.isPending}
            >
              {saveMutation.isPending ? "Saving…" : "Save"}
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          <div
            className={cn(
              "rounded-lg transition-colors",
              dragging && "bg-primary/5 ring-primary/40 ring-2",
            )}
            onDragOver={(e) => {
              if (Array.from(e.dataTransfer.types).includes("Files")) {
                e.preventDefault();
                setDragging(true);
              }
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragging(false);
              const file = e.dataTransfer.files?.[0];
              if (file) onUploadFile(file);
            }}
          >
            {isLoading ? (
              <Skeleton className="h-72 rounded-lg" />
            ) : (
              <Textarea
                value={content}
                rows={18}
                spellCheck={false}
                className="min-h-72 resize-y font-mono text-xs leading-relaxed"
                placeholder="Paste, upload, or drag a .md/.txt/.pdf/.docx file here. The pipeline uses this text to extract test points."
                onChange={(e) => {
                  setContent(e.target.value);
                  setDirty(true);
                }}
              />
            )}
          </div>
          <p className="text-muted-foreground mt-2 text-xs">
            {content.trim()
              ? `${content.trim().length.toLocaleString()} characters`
              : "Empty"}
            {dirty ? " · unsaved changes" : ""}
            {dragging ? " · drop to upload" : ""}
          </p>
        </CardContent>
      </Card>
    </div>
  );
}

function DetailRow({
  icon: Icon,
  label,
  value,
}: {
  icon: typeof FileText;
  label: string;
  value: string;
}) {
  return (
    <div className="flex items-start gap-3">
      <Icon
        className="text-muted-foreground mt-0.5 size-4 shrink-0"
        aria-hidden
      />
      <div className="min-w-0 flex-1">
        <p className="text-muted-foreground text-xs">{label}</p>
        <p className="font-medium break-words">{value}</p>
      </div>
    </div>
  );
}

export default OverviewTab;
