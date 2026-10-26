import {
  HeadContent,
  Link,
  Outlet,
  Scripts,
  createRootRouteWithContext,
  useRouter,
} from "@tanstack/react-router";
import { TanStackRouterDevtoolsPanel } from "@tanstack/react-router-devtools";
import { TanStackDevtools } from "@tanstack/react-devtools";

import TanStackQueryDevtools from "../integrations/tanstack-query/devtools";

import { AppSidebar } from "#/components/AppSidebar";
import { Button, buttonVariants } from "#/components/ui/button";
import { Toaster } from "#/components/ui/sonner";
import {
  SidebarInset,
  SidebarProvider,
  SidebarTrigger,
} from "#/components/ui/sidebar";
import { Separator } from "#/components/ui/separator";

import appCss from "../styles.css?url";

import type { QueryClient } from "@tanstack/react-query";
import type { TRPCRouter } from "#/integrations/trpc/router";
import type { TRPCOptionsProxy } from "@trpc/tanstack-react-query";

interface MyRouterContext {
  queryClient: QueryClient;
  trpc: TRPCOptionsProxy<TRPCRouter>;
}

const THEME_INIT_SCRIPT = `(function(){try{var stored=window.localStorage.getItem('theme');var mode=(stored==='light'||stored==='dark'||stored==='auto')?stored:'auto';var prefersDark=window.matchMedia('(prefers-color-scheme: dark)').matches;var resolved=mode==='auto'?(prefersDark?'dark':'light'):mode;var root=document.documentElement;root.classList.remove('light','dark');root.classList.add(resolved);if(mode==='auto'){root.removeAttribute('data-theme')}else{root.setAttribute('data-theme',mode)}root.style.colorScheme=resolved;}catch(e){}})();`;

export const Route = createRootRouteWithContext<MyRouterContext>()({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "Yukino Test Agent · AI Test Platform" },
      {
        name: "description",
        content:
          "AI-driven test case generation, browser execution, and evidence-based review.",
      },
    ],
    links: [{ rel: "stylesheet", href: appCss }],
  }),
  shellComponent: RootDocument,
  component: RootLayout,
  notFoundComponent: NotFound,
});

function RootDocument({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
        <HeadContent />
      </head>
      <body className="font-sans [overflow-wrap:anywhere] antialiased">
        {children}
        <TanStackDevtools
          config={{ position: "bottom-right" }}
          plugins={[
            {
              name: "Tanstack Router",
              render: <TanStackRouterDevtoolsPanel />,
            },
            TanStackQueryDevtools,
          ]}
        />
        <Scripts />
      </body>
    </html>
  );
}

function RootLayout() {
  return (
    <SidebarProvider>
      <AppSidebar />
      <SidebarInset>
        <header className="border-border/60 bg-background/80 supports-[backdrop-filter]:bg-background/60 sticky top-0 z-30 flex h-14 shrink-0 items-center gap-2 border-b px-4 backdrop-blur">
          <SidebarTrigger className="-ml-1" />
          <Separator
            orientation="vertical"
            className="mr-1 data-[orientation=vertical]:h-4"
          />
          <span className="text-muted-foreground text-sm font-medium">
            Yukino Test Agent
          </span>
        </header>
        <main className="flex flex-1 flex-col gap-6 p-4 md:p-6">
          <Outlet />
        </main>
      </SidebarInset>
      <Toaster richColors position="top-right" />
    </SidebarProvider>
  );
}

function NotFound() {
  const router = useRouter();
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-5 py-24 text-center">
      <p className="text-primary text-6xl font-bold tracking-tight">404</p>
      <div className="space-y-1.5">
        <h1 className="text-2xl font-semibold">Page not found</h1>
        <p className="text-muted-foreground mx-auto max-w-md text-sm">
          The link may be broken, or the resource may have been deleted.
        </p>
      </div>
      <div className="flex items-center gap-2">
        <Link to="/dashboard" className={buttonVariants()}>
          Back to dashboard
        </Link>
        <Button variant="outline" onClick={() => router.history.back()}>
          Go back
        </Button>
      </div>
    </div>
  );
}
