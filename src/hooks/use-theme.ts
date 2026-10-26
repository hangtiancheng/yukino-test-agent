import { useEffect, useState } from "react";

export type ResolvedTheme = "light" | "dark";

function readTheme(): ResolvedTheme {
  if (typeof document === "undefined") return "light";
  return document.documentElement.classList.contains("dark") ? "dark" : "light";
}

/**
 * Tracks the resolved light/dark theme applied by the custom theme system
 * (a `.dark`/`.light` class on <html>). Updates live via MutationObserver so
 * components like the toaster stay in sync with theme changes.
 */
export function useResolvedTheme(): ResolvedTheme {
  const [theme, setTheme] = useState<ResolvedTheme>(readTheme);

  useEffect(() => {
    const root = document.documentElement;
    setTheme(readTheme());
    const observer = new MutationObserver(() => setTheme(readTheme()));
    observer.observe(root, { attributes: true, attributeFilter: ["class"] });
    return () => observer.disconnect();
  }, []);

  return theme;
}
