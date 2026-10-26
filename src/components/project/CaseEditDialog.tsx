import { useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { ArrowDown, ArrowUp, Plus, Trash2 } from "lucide-react";

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
import { Separator } from "#/components/ui/separator";
import { Textarea } from "#/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "#/components/ui/select";
import { CASE_TYPE_META, PRIORITY_META } from "#/lib/enums";

import type { CaseDict } from "#/server/services/testcases";
import type { StructuredStep } from "#/lib/types";

const STEP_TYPES = [
  { value: "ui_action", label: "UI action" },
  { value: "input", label: "Input" },
  { value: "state_assert", label: "Assert" },
  { value: "capture", label: "Capture" },
] as const;

const SELECTOR_TYPES = [
  "route",
  "placeholder",
  "text",
  "label",
  "role",
  "testid",
  "css",
  "xpath",
] as const;

interface EditableStep {
  type: string;
  action: string;
  target: string;
  selectorType: string;
  selectorValue: string;
  expected: string;
  inputValue: string;
  variable: string;
  pattern: string;
}

function toEditable(steps: StructuredStep[]): EditableStep[] {
  return steps.map((step) => ({
    type: step.type,
    action: step.action,
    target: step.target,
    selectorType: step.uiSelector?.type ?? "text",
    selectorValue: step.uiSelector?.value ?? "",
    expected: step.expected ?? "",
    inputValue: step.inputValue ?? "",
    variable: step.variable ?? "",
    pattern: step.pattern ?? "",
  }));
}

function toStructured(steps: EditableStep[]): StructuredStep[] {
  return steps
    .filter((step) => step.action.trim() || step.target.trim())
    .map((step, index) => ({
      order: index + 1,
      type: step.type,
      action: step.action.trim(),
      target: step.target.trim(),
      uiSelector: { type: step.selectorType, value: step.selectorValue },
      ...(step.expected ? { expected: step.expected } : {}),
      ...(step.inputValue ? { inputValue: step.inputValue } : {}),
      ...(step.variable ? { variable: step.variable } : {}),
      ...(step.pattern ? { pattern: step.pattern } : {}),
    }));
}

function emptyStep(): EditableStep {
  return {
    type: "ui_action",
    action: "",
    target: "",
    selectorType: "text",
    selectorValue: "",
    expected: "",
    inputValue: "",
    variable: "",
    pattern: "",
  };
}

const linesToArray = (text: string): string[] =>
  text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

const arrayToLines = (items: string[]): string => items.join("\n");

function parseTestData(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const idx = trimmed.indexOf("=");
    if (idx <= 0) continue;
    out[trimmed.slice(0, idx).trim()] = trimmed.slice(idx + 1).trim();
  }
  return out;
}

function testDataToText(data: Record<string, string>): string {
  return Object.entries(data)
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
}

interface CaseEditDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: string;
  /** When provided the dialog edits this case; otherwise it creates one. */
  caseData?: CaseDict | null;
}

export function CaseEditDialog({
  open,
  onOpenChange,
  projectId,
  caseData = null,
}: CaseEditDialogProps) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const isEdit = Boolean(caseData);

  const [title, setTitle] = useState("");
  const [module, setModule] = useState("");
  const [type, setType] = useState("positive");
  const [priority, setPriority] = useState("P1");
  const [preconditions, setPreconditions] = useState("");
  const [expected, setExpected] = useState("");
  const [testData, setTestData] = useState("");
  const [steps, setSteps] = useState<EditableStep[]>([]);

  useEffect(() => {
    if (!open) return;
    setTitle(caseData?.title ?? "");
    setModule(caseData?.module ?? "");
    setType(caseData?.type ?? "positive");
    setPriority(caseData?.priority ?? "P1");
    setPreconditions(arrayToLines(caseData?.preconditions ?? []));
    setExpected(arrayToLines(caseData?.expectedResults ?? []));
    setTestData(testDataToText(caseData?.testData ?? {}));
    setSteps(toEditable(caseData?.structuredSteps ?? []));
  }, [open, caseData]);

  function invalidate() {
    queryClient.invalidateQueries({ queryKey: trpc.testcases.list.queryKey() });
    queryClient.invalidateQueries({ queryKey: trpc.testcases.get.queryKey() });
    queryClient.invalidateQueries({
      queryKey: trpc.testcases.versions.queryKey(),
    });
    queryClient.invalidateQueries({ queryKey: trpc.mindmap.tree.queryKey() });
  }

  const saveMutation = useMutation({
    ...trpc.testcases.update.mutationOptions({
      onSuccess: () => {
        toast.success("Case saved");
        invalidate();
        onOpenChange(false);
      },
      onError: (error) => toast.error(error.message),
    }),
    mutationKey: trpc.testcases.update.mutationKey(),
  });
  const createMutation = useMutation({
    ...trpc.testcases.createManual.mutationOptions({
      onSuccess: () => {
        toast.success("Case created");
        invalidate();
        onOpenChange(false);
      },
      onError: (error) => toast.error(error.message),
    }),
    mutationKey: trpc.testcases.createManual.mutationKey(),
  });

  const saving = saveMutation.isPending || createMutation.isPending;

  function payload() {
    const structuredSteps = toStructured(steps);
    return {
      title: title.trim(),
      module: module.trim(),
      type,
      priority,
      preconditions: linesToArray(preconditions),
      expectedResults: linesToArray(expected),
      structuredSteps,
      steps: structuredSteps.map((step) => step.action).filter(Boolean),
      testData: parseTestData(testData),
      changeNote: isEdit ? "Edited in UI" : undefined,
    };
  }

  function submit() {
    if (!title.trim()) {
      toast.error("A title is required");
      return;
    }
    if (isEdit && caseData) {
      saveMutation.mutate({ cid: caseData.id, ...payload() });
    } else {
      createMutation.mutate({ pid: projectId, ...payload() });
    }
  }

  function updateStep(index: number, patch: Partial<EditableStep>) {
    setSteps((prev) =>
      prev.map((step, i) => (i === index ? { ...step, ...patch } : step)),
    );
  }
  function moveStep(index: number, delta: number) {
    setSteps((prev) => {
      const target = index + delta;
      if (target < 0 || target >= prev.length) return prev;
      const next = [...prev];
      const [item] = next.splice(index, 1);
      next.splice(target, 0, item);
      return next;
    });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>{isEdit ? "Edit case" : "New case"}</DialogTitle>
          <DialogDescription>
            {isEdit
              ? "Changes are saved as a new version you can roll back to."
              : "Manual cases are marked as authored by hand and skip generation."}
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4 py-1">
          <div className="space-y-2">
            <Label htmlFor="case-title">Title</Label>
            <Input
              id="case-title"
              value={title}
              maxLength={200}
              placeholder="e.g. Create an order with a valid payload"
              onChange={(e) => setTitle(e.target.value)}
            />
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <div className="space-y-2">
              <Label htmlFor="case-module">Module</Label>
              <Input
                id="case-module"
                value={module}
                placeholder="Order"
                onChange={(e) => setModule(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label>Type</Label>
              <Select
                value={type}
                onValueChange={(v) => v !== null && setType(v)}
              >
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {Object.entries(CASE_TYPE_META).map(([code, m]) => (
                    <SelectItem key={code} value={code}>
                      {m.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>Priority</Label>
              <Select
                value={priority}
                onValueChange={(v) => v !== null && setPriority(v)}
              >
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {Object.entries(PRIORITY_META).map(([code, m]) => (
                    <SelectItem key={code} value={code}>
                      {m.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="case-pre">Preconditions</Label>
              <Textarea
                id="case-pre"
                rows={3}
                value={preconditions}
                placeholder={"One per line"}
                className="text-xs"
                onChange={(e) => setPreconditions(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="case-expected">Expected results</Label>
              <Textarea
                id="case-expected"
                rows={3}
                value={expected}
                placeholder={
                  'Quote visible copy, e.g. "Order created successfully"'
                }
                className="text-xs"
                onChange={(e) => setExpected(e.target.value)}
              />
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="case-data">Test data</Label>
            <Textarea
              id="case-data"
              rows={2}
              value={testData}
              placeholder={"key=value, one per line"}
              className="font-mono text-xs"
              onChange={(e) => setTestData(e.target.value)}
            />
          </div>

          <Separator />

          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium">Structured steps</p>
              <p className="text-muted-foreground text-xs">
                Consumed by the browser runner.
              </p>
            </div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setSteps((prev) => [...prev, emptyStep()])}
            >
              <Plus className="size-4" aria-hidden />
              Add step
            </Button>
          </div>

          {steps.length === 0 ? (
            <p className="border-border/70 text-muted-foreground rounded-lg border border-dashed px-3 py-6 text-center text-xs">
              No structured steps. The case cannot run automatically until at
              least one step is added.
            </p>
          ) : (
            <div className="flex flex-col gap-2">
              {steps.map((step, index) => (
                <div
                  key={index}
                  className="border-border/60 bg-muted/20 rounded-lg border p-3"
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-muted-foreground font-mono text-xs">
                      #{index + 1}
                    </span>
                    <Select
                      value={step.type}
                      onValueChange={(v) => {
                        if (v !== null) updateStep(index, { type: v });
                      }}
                    >
                      <SelectTrigger className="h-8 w-32 text-xs">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {STEP_TYPES.map((t) => (
                          <SelectItem key={t.value} value={t.value}>
                            {t.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <Input
                      value={step.action}
                      placeholder="Action"
                      className="h-8 min-w-40 flex-1 text-xs"
                      onChange={(e) =>
                        updateStep(index, { action: e.target.value })
                      }
                    />
                    <div className="ml-auto flex items-center gap-1">
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="size-7"
                        aria-label="Move up"
                        disabled={index === 0}
                        onClick={() => moveStep(index, -1)}
                      >
                        <ArrowUp className="size-3.5" aria-hidden />
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="size-7"
                        aria-label="Move down"
                        disabled={index === steps.length - 1}
                        onClick={() => moveStep(index, 1)}
                      >
                        <ArrowDown className="size-3.5" aria-hidden />
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="text-destructive hover:text-destructive size-7"
                        aria-label="Remove step"
                        onClick={() =>
                          setSteps((prev) => prev.filter((_, i) => i !== index))
                        }
                      >
                        <Trash2 className="size-3.5" aria-hidden />
                      </Button>
                    </div>
                  </div>
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    <Input
                      value={step.target}
                      placeholder="Target"
                      className="h-8 w-40 text-xs"
                      onChange={(e) =>
                        updateStep(index, { target: e.target.value })
                      }
                    />
                    <Select
                      value={step.selectorType}
                      onValueChange={(v) =>
                        v !== null && updateStep(index, { selectorType: v })
                      }
                    >
                      <SelectTrigger className="h-8 w-32 text-xs">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {SELECTOR_TYPES.map((t) => (
                          <SelectItem key={t} value={t}>
                            {t}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <Input
                      value={step.selectorValue}
                      placeholder="Selector value"
                      className="h-8 w-44 font-mono text-xs"
                      onChange={(e) =>
                        updateStep(index, { selectorValue: e.target.value })
                      }
                    />
                    {step.type === "input" ? (
                      <Input
                        value={step.inputValue}
                        placeholder="Input value"
                        className="h-8 w-36 text-xs"
                        onChange={(e) =>
                          updateStep(index, { inputValue: e.target.value })
                        }
                      />
                    ) : null}
                    {step.type === "state_assert" ? (
                      <Input
                        value={step.expected}
                        placeholder="Assertion text"
                        className="h-8 w-48 text-xs"
                        onChange={(e) =>
                          updateStep(index, { expected: e.target.value })
                        }
                      />
                    ) : null}
                    {step.type === "capture" ? (
                      <>
                        <Input
                          value={step.variable}
                          placeholder="Variable"
                          className="h-8 w-32 font-mono text-xs"
                          onChange={(e) =>
                            updateStep(index, { variable: e.target.value })
                          }
                        />
                        <Input
                          value={step.pattern}
                          placeholder="Regex with one group"
                          className="h-8 w-48 font-mono text-xs"
                          onChange={(e) =>
                            updateStep(index, { pattern: e.target.value })
                          }
                        />
                      </>
                    ) : null}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={saving}
          >
            Cancel
          </Button>
          <Button onClick={submit} disabled={saving}>
            {saving ? "Saving…" : isEdit ? "Save changes" : "Create case"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default CaseEditDialog;
