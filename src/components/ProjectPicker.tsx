import { useQuery } from "@tanstack/react-query";
import { FolderKanban } from "lucide-react";

import { useTRPC } from "#/integrations/trpc/react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "#/components/ui/select";

interface ProjectPickerProps {
  value: string | null;
  onChange: (projectId: string) => void;
  placeholder?: string;
  className?: string;
}

/** Dropdown to choose a project for project-scoped global views. */
export function ProjectPicker({
  value,
  onChange,
  placeholder,
  className,
}: ProjectPickerProps) {
  const trpc = useTRPC();
  const { data } = useQuery(trpc.projects.list.queryOptions());
  const projects = data ?? [];

  return (
    <Select
      value={value ?? undefined}
      onValueChange={(v) => {
        if (v !== null) onChange(v);
      }}
    >
      <SelectTrigger className={className ?? "w-64"}>
        <FolderKanban className="text-muted-foreground size-4" aria-hidden />
        <SelectValue placeholder={placeholder ?? "Select a project"} />
      </SelectTrigger>
      <SelectContent>
        {projects.map((project) => (
          <SelectItem key={project.id} value={project.id}>
            {project.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

export default ProjectPicker;
