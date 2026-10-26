/**
 * Transient toast helper. The message argument is the exact copy the app
 * renders, which the static analyzer collects as UI text. Styling is pure
 * Tailwind utilities toggled on a light-DOM host appended to document.body.
 */
const BASE_CLASSES =
  "pointer-events-none fixed left-1/2 top-5 z-50 -translate-x-1/2 rounded-lg px-4 py-2.5 text-sm font-medium shadow-lg ring-1 transition-opacity duration-200";

const KIND_CLASSES = {
  success: "bg-emerald-50 text-emerald-800 ring-emerald-200",
  error: "bg-red-50 text-red-800 ring-red-200",
} as const;

type ToastKind = keyof typeof KIND_CLASSES;

let hideTimer = 0;
let visibleKind: ToastKind = "success";

export function showToast(message: string, kind: ToastKind = "success"): void {
  visibleKind = kind;
  const host = toastHost();
  host.textContent = message;
  host.className = classesFor(kind, true);
  window.clearTimeout(hideTimer);
  hideTimer = window.setTimeout(() => {
    host.className = classesFor(visibleKind, false);
  }, 2500);
}

function classesFor(kind: ToastKind, visible: boolean): string {
  return `${BASE_CLASSES} ${KIND_CLASSES[kind]} ${visible ? "opacity-100" : "opacity-0"}`;
}

function toastHost(): HTMLElement {
  let host = document.getElementById("toast-host");
  if (!host) {
    host = document.createElement("div");
    host.id = "toast-host";
    host.setAttribute("role", "status");
    host.className = classesFor("success", false);
    document.body.appendChild(host);
  }
  return host;
}
