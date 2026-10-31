import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { FileUp, ListTree, Pencil, Plus, Sparkles, Trash2 } from "lucide-react";

import { useTRPC } from "#/integrations/trpc/react";
import { useJobPoller } from "#/hooks/use-job-poller";
import { EmptyState } from "#/components/EmptyState";
import { StatusBadge } from "#/components/StatusBadge";
import { Button } from "#/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "#/components/ui/card";
import { Input } from "#/components/ui/input";
import { Label } from "#/components/ui/label";
import { Progress } from "#/components/ui/progress";
import { Skeleton } from "#/components/ui/skeleton";
import { Textarea } from "#/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "#/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "#/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "#/components/ui/table";
import { PRIORITY_META, REQUIREMENT_STATUS_META, meta } from "#/lib/enums";
import { cn } from "#/lib/utils";
import { PRD_ACCEPT, validatePrdFile } from "#/lib/prd";

import type { RequirementDict } from "#/server/services/requirements";

export function RequirementsTab({ projectId }: { projectId: string }) {
  const trpc = useTRPC();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);

  const { data, isLoading } = useQuery(
    trpc.requirements.list.queryOptions({ pid: projectId }),
  );
  const requirements = data ?? [];

  useEffect(() => {
    if (
      requirements.length > 0 &&
      !requirements.some((r) => r.id === selectedId)
    ) {
      setSelectedId(requirements[0].id);
    }
  }, [requirements, selectedId]);

  const selected = requirements.find((r) => r.id === selectedId) ?? null;
  const [detailDirty, setDetailDirty] = useState(false);

  // Guard version switching so unsaved PRD edits are never silently dropped
  // when the detail panel remounts (legacy P2-1).
  const selectVersion = (id: string) => {
    if (id === selectedId) return;
    if (
      detailDirty &&
      !window.confirm(
        "You have unsaved PRD changes on this version. Discard them and switch?",
      )
    ) {
      return;
    }
    setDetailDirty(false);
    setSelectedId(id);
  };

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-4">
      <Card className="lg:col-span-1">
        <CardHeader className="flex-row items-center justify-between space-y-0 pb-3">
          <CardTitle className="text-base">Versions</CardTitle>
          <Button
            size="icon"
            variant="outline"
            className="size-7"
            aria-label="New version"
            onClick={() => setCreateOpen(true)}
          >
            <Plus className="size-4" aria-hidden />
          </Button>
        </CardHeader>
        <CardContent className="flex flex-col gap-2">
          {isLoading ? (
            <Skeleton className="h-24 rounded-lg" />
          ) : requirements.length === 0 ? (
            <p className="text-muted-foreground text-sm">
              No requirement versions yet.
            </p>
          ) : (
            requirements.map((requirement) => {
              const statusMeta = meta(
                REQUIREMENT_STATUS_META,
                requirement.status,
              );
              const active = requirement.id === selectedId;
              return (
                <button
                  key={requirement.id}
                  type="button"
                  onClick={() => selectVersion(requirement.id)}
                  className={cn(
                    "flex flex-col gap-1 rounded-lg border px-3 py-2 text-left transition-colors",
                    active
                      ? "border-primary/50 bg-primary/5"
                      : "border-border/60 hover:border-primary/30 hover:bg-muted/40",
                  )}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate text-sm font-medium">
                      {requirement.version}
                    </span>
                    <StatusBadge
                      tone={statusMeta.tone}
                      label={statusMeta.label}
                    />
                  </div>
                  <span className="text-muted-foreground truncate text-xs">
                    {requirement.name}
                  </span>
                  <span className="text-muted-foreground text-xs">
                    {requirement.testPointCount} points ·{" "}
                    {requirement.caseCount} cases
                  </span>
                </button>
              );
            })
          )}
        </CardContent>
      </Card>

      <div className="lg:col-span-3">
        {selected ? (
          <RequirementDetail
            key={selected.id}
            requirement={selected}
            onDirtyChange={setDetailDirty}
            onDeleted={() => setSelectedId(null)}
          />
        ) : (
          <EmptyState
            icon={ListTree}
            title="Select a requirement version"
            description="Create a version, attach the PRD, then extract test points to drive case generation."
            action={
              <Button onClick={() => setCreateOpen(true)}>
                <Plus className="size-4" aria-hidden />
                New version
              </Button>
            }
          />
        )}
      </div>

      <CreateRequirementDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        projectId={projectId}
        onCreated={(rid) => setSelectedId(rid)}
      />
    </div>
  );
}

function RequirementDetail({
  requirement,
  onDeleted,
  onDirtyChange,
}: {
  requirement: RequirementDict;
  onDeleted: () => void;
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [content, setContent] = useState(requirement.content ?? "");
  const [dirty, setDirty] = useState(false);
  useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);
  const [jobId, setJobId] = useState<string | null>(null);
  const job = useJobPoller(jobId);
  const finishedRef = useRef<string | null>(null);
  const [analyzeMode, setAnalyzeMode] = useState<"auto" | "rule" | "llm">(
    "auto",
  );
  const [profileId, setProfileId] = useState<string>(ALL_PROFILES);
  const [editOpen, setEditOpen] = useState(false);
  const [editVersion, setEditVersion] = useState(requirement.version);
  const [editName, setEditName] = useState(requirement.name);

  const profilesQuery = useQuery(trpc.settings.listProfiles.queryOptions());
  const textProfiles = (profilesQuery.data ?? []).filter(
    (profile) => profile.kind === "text",
  );

  const { data: full } = useQuery(
    trpc.requirements.get.queryOptions({ rid: requirement.id }),
  );
  useEffect(() => {
    if (full && "content" in full) {
      setContent(String(full.content ?? ""));
      setDirty(false);
    }
  }, [full]);

  const { data: pointsData, isLoading: pointsLoading } = useQuery(
    trpc.requirements.testPoints.queryOptions({ rid: requirement.id }),
  );
  const points = pointsData ?? [];

  useEffect(() => {
    if (job.isTerminal && jobId && finishedRef.current !== jobId) {
      finishedRef.current = jobId;
      if (job.isFailed)
        toast.error(job.error ?? "Test point extraction failed");
      else toast.success("Test points extracted");
      queryClient.invalidateQueries({
        queryKey: trpc.requirements.list.queryKey(),
      });
      queryClient.invalidateQueries({
        queryKey: trpc.requirements.testPoints.queryKey(),
      });
      setJobId(null);
    }
  }, [job.isTerminal, job.isFailed, job.error, jobId]);

  const uploadMutation = useMutation(
    trpc.requirements.uploadPrd.mutationOptions({
      onSuccess: () => {
        toast.success("PRD attached");
        queryClient.invalidateQueries({
          queryKey: trpc.requirements.get.queryKey(),
        });
        queryClient.invalidateQueries({
          queryKey: trpc.requirements.list.queryKey(),
        });
      },
      onError: (error) => toast.error(error.message),
    }),
  );
  const updateMutation = useMutation(
    trpc.requirements.update.mutationOptions({
      onSuccess: () => {
        toast.success("Content saved");
        setDirty(false);
        queryClient.invalidateQueries({
          queryKey: trpc.requirements.list.queryKey(),
        });
      },
      onError: (error) => toast.error(error.message),
    }),
  );
  const analyzeMutation = useMutation(
    trpc.requirements.analyze.mutationOptions({
      onSuccess: (result) => {
        setJobId(result.jobId);
        toast.info("Extracting test points…");
      },
      onError: (error) => toast.error(error.message),
    }),
  );
  const deleteMutation = useMutation(
    trpc.requirements.delete.mutationOptions({
      onSuccess: () => {
        toast.success("Version deleted");
        queryClient.invalidateQueries({
          queryKey: trpc.requirements.list.queryKey(),
        });
        onDeleted();
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
      uploadMutation.mutate({
        rid: requirement.id,
        filename: file.name,
        base64,
      });
    };
    reader.onerror = () =>
      toast.error(reader.error?.message ?? "Failed to read the file");
    reader.readAsDataURL(file);
  }

  const parsing = analyzeMutation.isPending || job.isRunning;
  const statusMeta = meta(REQUIREMENT_STATUS_META, requirement.status);

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader className="flex-row items-start justify-between space-y-0 pb-3">
          <div className="min-w-0">
            <CardTitle className="flex items-center gap-2 text-base">
              <span className="truncate">{requirement.version}</span>
              <StatusBadge tone={statusMeta.tone} label={statusMeta.label} />
            </CardTitle>
            <p className="text-muted-foreground mt-1 truncate text-sm">
              {requirement.name}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
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
              onClick={() => setEditOpen(true)}
            >
              <Pencil className="size-4" aria-hidden />
              Edit
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => fileInputRef.current?.click()}
              disabled={uploadMutation.isPending}
            >
              <FileUp className="size-4" aria-hidden />
              Upload
            </Button>
            <Button
              variant="outline"
              size="sm"
              aria-label="Delete version"
              className="text-destructive hover:text-destructive"
              onClick={() => deleteMutation.mutate({ rid: requirement.id })}
              disabled={deleteMutation.isPending}
            >
              <Trash2 className="size-4" aria-hidden />
            </Button>
          </div>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <div
            className={cn(
              "space-y-2 rounded-lg transition-colors",
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
            <Label htmlFor="prd-content">
              PRD content{dragging ? " · drop to upload" : ""}
            </Label>
            <Textarea
              id="prd-content"
              value={content}
              rows={10}
              spellCheck={false}
              className="min-h-40 resize-y font-mono text-xs leading-relaxed"
              placeholder="Paste, upload, or drag a .md/.txt/.pdf/.docx file here."
              onChange={(e) => {
                setContent(e.target.value);
                setDirty(true);
              }}
            />
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Select
              value={analyzeMode}
              onValueChange={(v) => setAnalyzeMode(v as typeof analyzeMode)}
            >
              <SelectTrigger className="h-8 w-36 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="auto">Auto (AI + rule)</SelectItem>
                <SelectItem value="llm">AI only</SelectItem>
                <SelectItem value="rule">Rule only</SelectItem>
              </SelectContent>
            </Select>
            <Select
              value={profileId}
              onValueChange={(v) => v !== null && setProfileId(v)}
              disabled={analyzeMode === "rule"}
            >
              <SelectTrigger className="h-8 w-44 text-xs">
                <SelectValue placeholder="Default profile" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL_PROFILES}>Default profile</SelectItem>
                {textProfiles.map((profile) => (
                  <SelectItem key={profile.id} value={profile.id}>
                    {profile.name} · {profile.model}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="flex items-center justify-between gap-2">
            <span className="text-muted-foreground text-xs">
              {content.trim()
                ? `${content.trim().length.toLocaleString()} characters`
                : "Empty"}
              {dirty ? " · unsaved" : ""}
            </span>
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() =>
                  updateMutation.mutate({ rid: requirement.id, content })
                }
                disabled={!dirty || updateMutation.isPending}
              >
                Save content
              </Button>
              <Button
                size="sm"
                onClick={() => {
                  const startAnalyze = () =>
                    analyzeMutation.mutate({
                      rid: requirement.id,
                      mode: analyzeMode,
                      profileId:
                        analyzeMode === "rule" || profileId === ALL_PROFILES
                          ? null
                          : profileId,
                    });
                  if (dirty) {
                    updateMutation.mutate(
                      { rid: requirement.id, content },
                      { onSuccess: startAnalyze },
                    );
                  } else {
                    startAnalyze();
                  }
                }}
                disabled={
                  parsing || updateMutation.isPending || !content.trim()
                }
              >
                <Sparkles className="size-4" aria-hidden />
                {parsing ? "Extracting…" : "Extract test points"}
              </Button>
            </div>
          </div>
          {parsing && job.progress !== null ? (
            <div className="flex items-center gap-3">
              <Progress value={job.progress * 100} className="flex-1" />
              <span className="text-muted-foreground text-xs">
                {job.message}
              </span>
            </div>
          ) : null}
          {requirement.errorMessage ? (
            <p className="text-destructive text-xs">
              {requirement.errorMessage}
            </p>
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">
            Test points ({points.length})
          </CardTitle>
        </CardHeader>
        <CardContent>
          {pointsLoading ? (
            <Skeleton className="h-40 rounded-lg" />
          ) : points.length === 0 ? (
            <EmptyState
              icon={ListTree}
              title="No test points"
              description="Extract test points from the PRD to see the scenarios the generator will cover."
              className="py-8"
            />
          ) : (
            <div className="border-border/60 max-h-96 overflow-auto rounded-lg border">
              <Table>
                <TableHeader>
                  <TableRow className="bg-muted/40 hover:bg-muted/40">
                    <TableHead className="w-12">#</TableHead>
                    <TableHead>Title</TableHead>
                    <TableHead className="w-28">Category</TableHead>
                    <TableHead className="w-20">Priority</TableHead>
                    <TableHead className="hidden w-20 md:table-cell">
                      Source
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {points.map((point) => {
                    const priorityMeta = meta(PRIORITY_META, point.priority);
                    return (
                      <TableRow key={point.id}>
                        <TableCell className="text-muted-foreground font-mono text-xs">
                          {point.seq}
                        </TableCell>
                        <TableCell>
                          <p className="font-medium">{point.title}</p>
                          {point.expected ? (
                            <p className="text-muted-foreground line-clamp-1 text-xs">
                              {point.expected}
                            </p>
                          ) : null}
                        </TableCell>
                        <TableCell>
                          <StatusBadge tone="info" label={point.category} />
                        </TableCell>
                        <TableCell>
                          <StatusBadge
                            tone={priorityMeta.tone}
                            label={priorityMeta.label}
                          />
                        </TableCell>
                        <TableCell className="text-muted-foreground hidden text-xs md:table-cell">
                          {point.source}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>
      <EditRequirementDialog
        open={editOpen}
        onOpenChange={setEditOpen}
        rid={requirement.id}
        version={editVersion}
        name={editName}
        onVersionChange={setEditVersion}
        onNameChange={setEditName}
      />
    </div>
  );
}

const ALL_PROFILES = "__default__";

function EditRequirementDialog({
  open,
  onOpenChange,
  rid,
  version,
  name,
  onVersionChange,
  onNameChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  rid: string;
  version: string;
  name: string;
  onVersionChange: (value: string) => void;
  onNameChange: (value: string) => void;
}) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const updateMutation = useMutation(
    trpc.requirements.update.mutationOptions({
      onSuccess: () => {
        toast.success("Version updated");
        queryClient.invalidateQueries({
          queryKey: trpc.requirements.list.queryKey(),
        });
        onOpenChange(false);
      },
      onError: (error) => toast.error(error.message),
    }),
  );
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Edit requirement version</DialogTitle>
          <DialogDescription>
            Rename this version or change its label.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-4 py-2">
          <div className="space-y-2">
            <Label htmlFor="req-version">Version</Label>
            <Input
              id="req-version"
              value={version}
              maxLength={40}
              placeholder="V1.0"
              onChange={(e) => onVersionChange(e.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="req-name">Name</Label>
            <Input
              id="req-name"
              value={name}
              maxLength={120}
              placeholder="Order main flow"
              onChange={(e) => onNameChange(e.target.value)}
            />
          </div>
        </div>
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={updateMutation.isPending}
          >
            Cancel
          </Button>
          <Button
            onClick={() => updateMutation.mutate({ rid, version, name })}
            disabled={
              updateMutation.isPending || !version.trim() || !name.trim()
            }
          >
            {updateMutation.isPending ? "Saving…" : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function CreateRequirementDialog({
  open,
  onOpenChange,
  projectId,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: string;
  onCreated: (rid: string) => void;
}) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const [version, setVersion] = useState("");

  useEffect(() => {
    if (open) {
      setName("");
      setVersion("");
    }
  }, [open]);

  const createMutation = useMutation(
    trpc.requirements.create.mutationOptions({
      onSuccess: (result) => {
        toast.success("Requirement version created");
        queryClient.invalidateQueries({
          queryKey: trpc.requirements.list.queryKey(),
        });
        onOpenChange(false);
        const rid = (result as { id?: string }).id;
        if (rid) onCreated(rid);
      },
      onError: (error) => toast.error(error.message),
    }),
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>New requirement version</DialogTitle>
          <DialogDescription>
            A version groups a PRD snapshot with the test points and cases
            derived from it.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-4 py-2">
          <div className="space-y-2">
            <Label htmlFor="req-version">Version label</Label>
            <Input
              id="req-version"
              value={version}
              placeholder="v1.0"
              onChange={(e) => setVersion(e.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="req-name">Name</Label>
            <Input
              id="req-name"
              value={name}
              placeholder="Order management"
              onChange={(e) => setName(e.target.value)}
            />
          </div>
        </div>
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={createMutation.isPending}
          >
            Cancel
          </Button>
          <Button
            onClick={() =>
              createMutation.mutate({
                pid: projectId,
                name: name.trim() || undefined,
                version: version.trim() || undefined,
              })
            }
            disabled={createMutation.isPending}
          >
            {createMutation.isPending ? "Creating…" : "Create"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default RequirementsTab;
