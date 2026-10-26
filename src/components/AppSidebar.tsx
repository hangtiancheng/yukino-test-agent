import { Link, useRouterState } from "@tanstack/react-router";
import {
  FolderKanban,
  LayoutDashboard,
  ListChecks,
  Settings,
  Sparkles,
  Workflow,
  PlayCircle,
} from "lucide-react";

import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
} from "#/components/ui/sidebar";
import { ThemeToggle } from "#/components/ThemeToggle";
import { cn } from "#/lib/utils";

import type { LucideIcon } from "lucide-react";

interface NavItem {
  to: string;
  label: string;
  icon: LucideIcon;
  /** Match by prefix so nested routes keep the parent highlighted. */
  match: "exact" | "prefix";
}

const NAV: NavItem[] = [
  {
    to: "/dashboard",
    label: "Dashboard",
    icon: LayoutDashboard,
    match: "prefix",
  },
  { to: "/projects", label: "Projects", icon: FolderKanban, match: "prefix" },
  { to: "/testcases", label: "Test Cases", icon: ListChecks, match: "prefix" },
  { to: "/pipeline", label: "Pipeline", icon: Workflow, match: "prefix" },
  { to: "/executions", label: "Executions", icon: PlayCircle, match: "prefix" },
  { to: "/settings", label: "Settings", icon: Settings, match: "exact" },
];

function isActive(pathname: string, item: NavItem): boolean {
  if (item.match === "exact") return pathname === item.to;
  return pathname === item.to || pathname.startsWith(`${item.to}/`);
}

export function AppSidebar() {
  const pathname = useRouterState({
    select: (state) => state.location.pathname,
  });

  return (
    <Sidebar collapsible="icon" variant="inset">
      <SidebarHeader className="border-sidebar-border/60 border-b">
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              render={<Link to="/dashboard" />}
              className="h-12 gap-2.5 px-2.5"
              isActive={false}
            >
              <span className="from-primary to-info text-primary-foreground flex size-7 shrink-0 items-center justify-center rounded-md bg-gradient-to-br shadow-sm ring-1 ring-white/10 ring-inset">
                <Sparkles className="size-4" aria-hidden />
              </span>
              <span className="flex min-w-0 flex-col leading-tight group-data-[collapsible=icon]:hidden">
                <span className="truncate text-sm font-semibold tracking-tight">
                  Yukino Test Agent
                </span>
                <span className="text-muted-foreground truncate text-[11px]">
                  AI Test Platform
                </span>
              </span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>

      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel className="group-data-[collapsible=icon]:hidden">
            Workspace
          </SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {NAV.map((item) => {
                const active = isActive(pathname, item);
                return (
                  <SidebarMenuItem key={item.to}>
                    <SidebarMenuButton
                      render={<Link to={item.to} />}
                      isActive={active}
                      tooltip={item.label}
                    >
                      <item.icon aria-hidden />
                      <span>{item.label}</span>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                );
              })}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>

      <SidebarFooter className="border-sidebar-border/60 border-t">
        <div
          className={cn(
            "flex items-center justify-between gap-2 px-1 py-1",
            "group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:px-0",
          )}
        >
          <span className="text-muted-foreground truncate text-[11px] group-data-[collapsible=icon]:hidden">
            Theme
          </span>
          <ThemeToggle />
        </div>
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  );
}

export default AppSidebar;
