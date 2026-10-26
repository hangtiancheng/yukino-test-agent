import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  ChevronRight,
  Download,
  FoldVertical,
  Network,
  UnfoldVertical,
} from "lucide-react";

import { useTRPC } from "#/integrations/trpc/react";
import { EmptyState } from "#/components/EmptyState";
import { Button } from "#/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "#/components/ui/card";
import { Skeleton } from "#/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "#/components/ui/select";
import { cn } from "#/lib/utils";

import type { MindmapNode } from "#/server/lib/mindmap";

const ALL = "__all__";

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

export function MindmapTab({ projectId }: { projectId: string }) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const [requirementId, setRequirementId] = useState<string>(ALL);
  const [expandToken, setExpandToken] = useState(0);
  const [defaultOpen, setDefaultOpen] = useState(true);

  const scope = {
    pid: projectId,
    requirementId: requirementId === ALL ? null : requirementId,
  };
  const { data, isLoading } = useQuery(trpc.mindmap.tree.queryOptions(scope));
  const requirementsQuery = useQuery(
    trpc.requirements.list.queryOptions({ pid: projectId }),
  );
  const requirements = (requirementsQuery.data ?? []) as {
    id: string;
    version: string;
    name: string;
  }[];
  const result = data ?? null;

  async function downloadMarkdown() {
    try {
      const markdown = await queryClient.fetchQuery(
        trpc.mindmap.markdown.queryOptions(scope),
      );
      downloadBlob(
        new Blob([String(markdown)], { type: "text/markdown;charset=utf-8" }),
        `mindmap-${projectId.slice(0, 8)}.md`,
      );
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Export failed");
    }
  }

  async function downloadXmind() {
    try {
      const base64 = await queryClient.fetchQuery(
        trpc.mindmap.xmind.queryOptions(scope),
      );
      const bytes = Uint8Array.from(atob(String(base64)), (c) =>
        c.charCodeAt(0),
      );
      downloadBlob(
        new Blob([bytes], { type: "application/zip" }),
        `mindmap-${projectId.slice(0, 8)}.xmind`,
      );
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Export failed");
    }
  }

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between gap-2 space-y-0 pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <Network className="text-muted-foreground size-4" aria-hidden />
          Test case mindmap
        </CardTitle>
        <div className="flex flex-wrap items-center gap-2">
          <Select
            value={requirementId}
            onValueChange={(v) => v !== null && setRequirementId(v)}
          >
            <SelectTrigger className="h-8 w-44 text-xs">
              <SelectValue placeholder="Requirement" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>All requirements</SelectItem>
              {requirements.map((r) => (
                <SelectItem key={r.id} value={r.id}>
                  {r.version} · {r.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            variant="outline"
            size="sm"
            aria-label="Expand all"
            onClick={() => {
              setDefaultOpen(true);
              setExpandToken((t) => t + 1);
            }}
            disabled={!result}
          >
            <UnfoldVertical className="size-4" aria-hidden />
          </Button>
          <Button
            variant="outline"
            size="sm"
            aria-label="Collapse all"
            onClick={() => {
              setDefaultOpen(false);
              setExpandToken((t) => t + 1);
            }}
            disabled={!result}
          >
            <FoldVertical className="size-4" aria-hidden />
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={downloadMarkdown}
            disabled={!result}
          >
            <Download className="size-4" aria-hidden />
            Markdown
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={downloadXmind}
            disabled={!result}
          >
            <Download className="size-4" aria-hidden />
            XMind
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <Skeleton className="h-64 rounded-lg" />
        ) : !result || result.tree.children?.length === 0 ? (
          <EmptyState
            icon={Network}
            title="No cases to map"
            description="Generate or import test cases to build the mindmap."
          />
        ) : (
          <div className="flex flex-col gap-3">
            <div className="text-muted-foreground flex flex-wrap gap-2 text-xs">
              <span>{result.statistics.modules} modules</span>
              <span>·</span>
              <span>{result.statistics.types} types</span>
              <span>·</span>
              <span>{result.statistics.cases} cases</span>
              <span>·</span>
              <span>{result.statistics.leaves} leaves</span>
            </div>
            <div className="border-border/60 bg-muted/20 max-h-[32rem] overflow-auto rounded-lg border p-3">
              <TreeNode
                key={`${expandToken}-${requirementId}`}
                node={result.tree}
                depth={0}
                defaultOpen={defaultOpen}
              />
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function TreeNode({
  node,
  depth,
  defaultOpen = false,
}: {
  node: MindmapNode;
  depth: number;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen || depth < 1);
  const hasChildren = Boolean(node.children && node.children.length > 0);

  return (
    <div className="select-none">
      <div
        className={cn(
          "group hover:bg-muted/60 flex items-center gap-1 rounded-md py-1 pr-2",
          hasChildren && "cursor-pointer",
        )}
        style={{ paddingLeft: `${depth * 14 + 4}px` }}
        onClick={() => hasChildren && setOpen((v) => !v)}
        role={hasChildren ? "button" : undefined}
        tabIndex={hasChildren ? 0 : undefined}
        onKeyDown={(e) => {
          if (hasChildren && (e.key === "Enter" || e.key === " ")) {
            e.preventDefault();
            setOpen((v) => !v);
          }
        }}
      >
        {hasChildren ? (
          <ChevronRight
            className={cn(
              "text-muted-foreground size-3.5 shrink-0 transition-transform",
              open && "rotate-90",
            )}
            aria-hidden
          />
        ) : (
          <span
            className="bg-border mx-1 size-1.5 shrink-0 rounded-full"
            aria-hidden
          />
        )}
        <span
          className={cn(
            "truncate text-sm",
            depth === 0 && "font-semibold",
            depth === 1 && "font-medium",
            !hasChildren && "text-muted-foreground",
          )}
          title={node.title}
        >
          {node.title}
        </span>
      </div>
      {hasChildren && open ? (
        <div
          className="border-border/40 border-l"
          style={{ marginLeft: `${depth * 14 + 10}px` }}
        >
          {node.children!.map((child) => (
            <TreeNode
              key={child.id}
              node={child}
              depth={depth + 1}
              defaultOpen={defaultOpen}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

export default MindmapTab;
