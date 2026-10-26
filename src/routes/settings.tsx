import { useEffect, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Bot, Eye, Pencil, Plus, Star, Trash2, Zap } from "lucide-react";

import { useTRPC } from "#/integrations/trpc/react";
import { PageHeader } from "#/components/PageHeader";
import { StatusBadge } from "#/components/StatusBadge";
import { Button } from "#/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "#/components/ui/card";
import { Input } from "#/components/ui/input";
import { Label } from "#/components/ui/label";
import { Skeleton } from "#/components/ui/skeleton";
import { Switch } from "#/components/ui/switch";
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

import type { LlmProfileDict } from "#/lib/types";
import type { SettingsInfo } from "#/server/services/settings";

export const Route = createFileRoute("/settings")({
  component: SettingsPage,
});

function SettingsPage() {
  const trpc = useTRPC();
  const { data, isLoading } = useQuery(trpc.settings.info.queryOptions());
  const info = data ?? null;

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-6">
      <PageHeader
        title="Settings"
        description="Configure the LLM profiles used for AI generation, review, and analysis."
      />

      {isLoading ? (
        <Skeleton className="h-40 rounded-xl" />
      ) : info ? (
        <EnvironmentCard info={info} />
      ) : null}

      <ProfilesSection />
    </div>
  );
}

function EnvironmentCard({ info }: { info: SettingsInfo }) {
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">Environment</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="flex flex-wrap gap-2">
          <StatusBadge
            tone={info.textConfigured ? "success" : "warning"}
            label={
              info.textConfigured
                ? "Text model configured"
                : "Text model not configured"
            }
          />
          <StatusBadge
            tone={info.visionConfigured ? "success" : "warning"}
            label={
              info.visionConfigured
                ? "Vision model configured"
                : "Vision model not configured"
            }
          />
          {info.visionUsesTextFallback ? (
            <StatusBadge
              tone="info"
              label="Vision falls back to text profile"
            />
          ) : null}
        </div>
        <div className="grid grid-cols-1 gap-4 text-sm md:grid-cols-2">
          <div>
            <p className="text-muted-foreground text-xs">Default target URL</p>
            <p className="font-mono text-xs">{info.targetUrlDefault || "—"}</p>
          </div>
          <div>
            <p className="text-muted-foreground text-xs">Output directory</p>
            <p className="font-mono text-xs">{info.outputDir || "—"}</p>
          </div>
          <div>
            <p className="text-muted-foreground text-xs">Env text model</p>
            <p className="font-mono text-xs">
              {info.env.llmModel || "—"}
              {info.env.llmApiKeyConfigured ? " · key set" : " · no key"}
            </p>
          </div>
          <div>
            <p className="text-muted-foreground text-xs">Env vision model</p>
            <p className="font-mono text-xs">
              {info.env.llmVisionModel || "— (uses text)"}
            </p>
          </div>
        </div>
        <p className="text-muted-foreground text-xs">
          Environment values come from{" "}
          <code className="font-mono">.env.local</code>. Profiles defined below
          take precedence when selected as default.
        </p>
      </CardContent>
    </Card>
  );
}

function ProfilesSection() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<LlmProfileDict | null>(null);
  const [testingId, setTestingId] = useState<string | null>(null);

  const { data, isLoading } = useQuery(
    trpc.settings.listProfiles.queryOptions(),
  );
  const profiles = data ?? [];
  const textProfiles = profiles.filter((p) => p.kind === "text");
  const visionProfiles = profiles.filter((p) => p.kind === "vision");

  function invalidate() {
    queryClient.invalidateQueries({
      queryKey: trpc.settings.listProfiles.queryKey(),
    });
    queryClient.invalidateQueries({ queryKey: trpc.settings.info.queryKey() });
  }

  const setDefaultMutation = useMutation(
    trpc.settings.setDefaultProfile.mutationOptions({
      onSuccess: () => {
        toast.success("Default profile updated");
        invalidate();
      },
      onError: (error) => toast.error(error.message),
    }),
  );
  const deleteMutation = useMutation(
    trpc.settings.deleteProfile.mutationOptions({
      onSuccess: () => {
        toast.success("Profile deleted");
        invalidate();
      },
      onError: (error) => toast.error(error.message),
    }),
  );
  const testMutation = useMutation(
    trpc.settings.testLlm.mutationOptions({
      onSuccess: (result) => {
        const model = (result as { model?: string }).model;
        toast.success(
          model ? `Connection successful · ${model}` : "Connection successful",
        );
        setTestingId(null);
      },
      onError: (error) => {
        toast.error(error.message);
        setTestingId(null);
      },
    }),
  );

  function openCreate(kind: "text" | "vision") {
    setEditing({
      id: "",
      name: "",
      kind,
      apiKey: "",
      apiKeyConfigured: false,
      baseUrl: "",
      model: "",
      enabled: true,
      isDefault: false,
      createdAt: null,
      updatedAt: null,
    });
    setDialogOpen(true);
  }
  function openEdit(profile: LlmProfileDict) {
    setEditing(profile);
    setDialogOpen(true);
  }
  function testProfile(profile: LlmProfileDict) {
    setTestingId(profile.id);
    testMutation.mutate({ profileId: profile.id, kind: profile.kind });
  }

  return (
    <div className="flex flex-col gap-4">
      <ProfileTable
        title="Text profiles"
        icon={<Bot className="text-muted-foreground size-4" aria-hidden />}
        description="Used for test point extraction and case generation."
        profiles={textProfiles}
        isLoading={isLoading}
        onAdd={() => openCreate("text")}
        onEdit={openEdit}
        onSetDefault={(id) => setDefaultMutation.mutate({ id })}
        onDelete={(id) => deleteMutation.mutate({ id })}
        onTest={testProfile}
        testingId={testingId}
      />
      <ProfileTable
        title="Vision profiles"
        icon={<Eye className="text-muted-foreground size-4" aria-hidden />}
        description="Used to review execution screenshots. Falls back to the text profile."
        profiles={visionProfiles}
        isLoading={isLoading}
        onAdd={() => openCreate("vision")}
        onEdit={openEdit}
        onSetDefault={(id) => setDefaultMutation.mutate({ id })}
        onDelete={(id) => deleteMutation.mutate({ id })}
        onTest={testProfile}
        testingId={testingId}
      />

      <ProfileDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        profile={editing}
        onSaved={invalidate}
      />
    </div>
  );
}

function ProfileTable({
  title,
  icon,
  description,
  profiles,
  isLoading,
  onAdd,
  onEdit,
  onSetDefault,
  onDelete,
  onTest,
  testingId,
}: {
  title: string;
  icon: React.ReactNode;
  description: string;
  profiles: LlmProfileDict[];
  isLoading: boolean;
  onAdd: () => void;
  onEdit: (profile: LlmProfileDict) => void;
  onSetDefault: (id: string) => void;
  onDelete: (id: string) => void;
  onTest: (profile: LlmProfileDict) => void;
  testingId: string | null;
}) {
  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between space-y-0 pb-3">
        <div>
          <CardTitle className="flex items-center gap-2 text-base">
            {icon}
            {title}
          </CardTitle>
          <p className="text-muted-foreground mt-1 text-sm">{description}</p>
        </div>
        <Button variant="outline" size="sm" onClick={onAdd}>
          <Plus className="size-4" aria-hidden />
          Add
        </Button>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <Skeleton className="h-24 rounded-lg" />
        ) : profiles.length === 0 ? (
          <p className="text-muted-foreground text-sm">No profiles yet.</p>
        ) : (
          <div className="border-border/60 overflow-hidden rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow className="bg-muted/40 hover:bg-muted/40">
                  <TableHead>Name</TableHead>
                  <TableHead>Model</TableHead>
                  <TableHead className="hidden md:table-cell">
                    Base URL
                  </TableHead>
                  <TableHead className="w-24">API key</TableHead>
                  <TableHead className="w-20">Enabled</TableHead>
                  <TableHead className="w-36 text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {profiles.map((profile) => (
                  <TableRow key={profile.id}>
                    <TableCell>
                      <div className="flex items-center gap-2">
                        <span className="font-medium">{profile.name}</span>
                        {profile.isDefault ? (
                          <StatusBadge tone="success" label="Default" />
                        ) : null}
                      </div>
                    </TableCell>
                    <TableCell className="font-mono text-xs">
                      {profile.model || "—"}
                    </TableCell>
                    <TableCell className="text-muted-foreground hidden max-w-40 truncate font-mono text-xs md:table-cell">
                      {profile.baseUrl || "—"}
                    </TableCell>
                    <TableCell>
                      <StatusBadge
                        tone={profile.apiKeyConfigured ? "success" : "warning"}
                        label={profile.apiKeyConfigured ? "Set" : "Missing"}
                      />
                    </TableCell>
                    <TableCell>
                      <StatusBadge
                        tone={profile.enabled ? "success" : "info"}
                        label={profile.enabled ? "On" : "Off"}
                      />
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center justify-end gap-1">
                        {!profile.isDefault ? (
                          <Button
                            variant="ghost"
                            size="icon"
                            className="size-7"
                            aria-label="Set as default"
                            title="Set as default"
                            onClick={() => onSetDefault(profile.id)}
                          >
                            <Star className="size-3.5" aria-hidden />
                          </Button>
                        ) : null}
                        <Button
                          variant="ghost"
                          size="icon"
                          className="size-7"
                          aria-label="Test connection"
                          title="Test connection"
                          onClick={() => onTest(profile)}
                          disabled={testingId === profile.id}
                        >
                          <Zap className="size-3.5" aria-hidden />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="size-7"
                          aria-label="Edit profile"
                          onClick={() => onEdit(profile)}
                        >
                          <Pencil className="size-3.5" aria-hidden />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="text-destructive hover:text-destructive size-7"
                          aria-label="Delete profile"
                          onClick={() => onDelete(profile.id)}
                        >
                          <Trash2 className="size-3.5" aria-hidden />
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function ProfileDialog({
  open,
  onOpenChange,
  profile,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  profile: LlmProfileDict | null;
  onSaved: () => void;
}) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const isEdit = Boolean(profile?.id);
  const [form, setForm] = useState({
    name: "",
    kind: "text" as "text" | "vision",
    apiKey: "",
    baseUrl: "",
    model: "",
    enabled: true,
  });

  useEffect(() => {
    if (!open) return;
    if (profile && profile.id) {
      setForm({
        name: profile.name,
        kind: profile.kind,
        apiKey: "",
        baseUrl: profile.baseUrl,
        model: profile.model,
        enabled: profile.enabled,
      });
    } else if (profile) {
      setForm({
        name: "",
        kind: profile.kind,
        apiKey: "",
        baseUrl: "",
        model: "",
        enabled: true,
      });
    }
  }, [open, profile]);

  const createMutation = useMutation(
    trpc.settings.createProfile.mutationOptions({
      onSuccess: () => {
        toast.success("Profile created");
        queryClient.invalidateQueries({
          queryKey: trpc.settings.listProfiles.queryKey(),
        });
        queryClient.invalidateQueries({
          queryKey: trpc.settings.info.queryKey(),
        });
        onSaved();
        onOpenChange(false);
      },
      onError: (error) => toast.error(error.message),
    }),
  );
  const updateMutation = useMutation(
    trpc.settings.updateProfile.mutationOptions({
      onSuccess: () => {
        toast.success("Profile updated");
        queryClient.invalidateQueries({
          queryKey: trpc.settings.listProfiles.queryKey(),
        });
        queryClient.invalidateQueries({
          queryKey: trpc.settings.info.queryKey(),
        });
        onSaved();
        onOpenChange(false);
      },
      onError: (error) => toast.error(error.message),
    }),
  );

  const submitting = createMutation.isPending || updateMutation.isPending;

  function onSubmit() {
    if (!form.name.trim()) {
      toast.error("Profile name is required");
      return;
    }
    const payload = {
      name: form.name.trim(),
      kind: form.kind,
      apiKey: form.apiKey.trim() || null,
      baseUrl: form.baseUrl.trim() || null,
      model: form.model.trim() || null,
      enabled: form.enabled,
    };
    if (isEdit && profile) {
      updateMutation.mutate({ id: profile.id, ...payload });
    } else {
      createMutation.mutate(payload);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            {isEdit ? "Edit profile" : "New LLM profile"}
          </DialogTitle>
          <DialogDescription>
            Provide the endpoint and credentials for an OpenAI-compatible model.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-4 py-2">
          <div className="space-y-2">
            <Label htmlFor="profile-name">Name</Label>
            <Input
              id="profile-name"
              value={form.name}
              placeholder="Primary text model"
              onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
            />
          </div>
          <div className="space-y-2">
            <Label>Kind</Label>
            <Select
              value={form.kind}
              onValueChange={(v) =>
                setForm((f) => ({ ...f, kind: v as "text" | "vision" }))
              }
              disabled={isEdit}
            >
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="text">Text</SelectItem>
                <SelectItem value="vision">Vision</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="profile-model">Model</Label>
            <Input
              id="profile-model"
              value={form.model}
              placeholder="gpt-4o-mini"
              onChange={(e) =>
                setForm((f) => ({ ...f, model: e.target.value }))
              }
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="profile-base-url">Base URL</Label>
            <Input
              id="profile-base-url"
              value={form.baseUrl}
              placeholder="https://api.openai.com/v1"
              onChange={(e) =>
                setForm((f) => ({ ...f, baseUrl: e.target.value }))
              }
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="profile-api-key">API key</Label>
            <Input
              id="profile-api-key"
              type="password"
              value={form.apiKey}
              placeholder={
                isEdit ? "Leave empty to keep the current key" : "sk-…"
              }
              onChange={(e) =>
                setForm((f) => ({ ...f, apiKey: e.target.value }))
              }
            />
          </div>
          <div className="border-border/60 flex items-center justify-between rounded-lg border px-3 py-2">
            <p className="text-sm font-medium">Enabled</p>
            <Switch
              checked={form.enabled}
              onCheckedChange={(v) => setForm((f) => ({ ...f, enabled: v }))}
            />
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
          <Button onClick={onSubmit} disabled={submitting}>
            {submitting
              ? "Saving…"
              : isEdit
                ? "Save changes"
                : "Create profile"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
