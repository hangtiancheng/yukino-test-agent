import { LitElement, customElement, state } from "@yukino.js/lit-jsx";

/**
 * Minimal history-mode router. The published @yukino.js/lit-jsx@0.0.1 does
 * not ship the `community` entry point, so the sample app vendors this tiny
 * stand-in: a route table with `to` redirects, same-origin anchor
 * interception, programmatic navigation, and a <route-view> element that
 * renders the matched route's element in light DOM.
 */
export interface RouteConfig {
  path: string;
  /** Redirect target; redirects always apply via history.replaceState. */
  to?: string;
  /** Kept for route-table parity; redirects replace by default. */
  replace?: boolean;
  /** JSX element; lit-jsx types JSX output as unknown. */
  element?: unknown;
}

let routes: RouteConfig[] = [];
const listeners = new Set<() => void>();

/** Root-based path: collapse repeated slashes, drop the trailing slash. */
function normalize(target: string): string {
  let out = target.startsWith("/") ? target : `/${target}`;
  out = out.replaceAll(/\/{2,}/g, "/");
  if (out.length > 1 && out.endsWith("/")) out = out.slice(0, -1);
  return out;
}

/** Match the current location, applying `to` redirects (cycle-safe). */
function resolve(): RouteConfig | null {
  const seen = new Set<string>();
  let target = normalize(window.location.pathname);
  for (;;) {
    if (seen.has(target)) return null;
    seen.add(target);
    const match = routes.find((route) => normalize(route.path) === target);
    if (!match) return null;
    if (!match.to) return match;
    target = normalize(match.to);
    window.history.replaceState(window.history.state, "", target);
  }
}

function notify(): void {
  for (const listener of [...listeners]) listener();
}

/** SPA navigation: push a path, resolve redirects, re-render route views. */
export function navigate(target: string): void {
  const next = normalize(target);
  if (next !== normalize(window.location.pathname)) {
    window.history.pushState({}, "", next);
  }
  resolve();
  notify();
}

export function createBrowserRouter(configs: RouteConfig[]): void {
  routes = configs;
  window.addEventListener("popstate", () => {
    resolve();
    notify();
  });
  // Unmodified same-origin anchor clicks become SPA navigations.
  document.addEventListener("click", (event) => {
    if (event.defaultPrevented || event.button !== 0) return;
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)
      return;
    const anchor = (event.target as Element | null)?.closest?.(
      "a[href]",
    ) as HTMLAnchorElement | null;
    if (!anchor || anchor.target === "_blank") return;
    const url = new URL(anchor.href, window.location.href);
    if (url.origin !== window.location.origin) return;
    event.preventDefault();
    navigate(url.pathname + url.search);
  });
  resolve();
}

/** Renders the element of the route matched by the current location. */
@customElement("route-view")
export class RouteView extends LitElement {
  @state() private match: RouteConfig | null = null;

  protected override createRenderRoot() {
    return this;
  }

  override connectedCallback(): void {
    super.connectedCallback();
    listeners.add(this.sync);
    this.sync();
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    listeners.delete(this.sync);
  }

  private sync = (): void => {
    this.match = resolve();
  };

  render() {
    if (this.match?.element) return this.match.element;
    return (
      <section class="mx-auto max-w-xl px-4 py-24 text-center">
        <h1 class="text-2xl font-semibold tracking-tight text-slate-900">
          Page not found
        </h1>
        <p class="mt-2 text-sm text-slate-500">
          No page matches the current address.
        </p>
        <a
          class="mt-6 inline-block rounded-lg bg-indigo-600 px-5 py-2 text-sm font-medium text-white shadow-sm transition-colors hover:bg-indigo-500"
          href="/orders/list"
        >
          Back to order list
        </a>
      </section>
    );
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "route-view": RouteView;
  }
}
