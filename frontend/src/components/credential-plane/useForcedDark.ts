import { useLayoutEffect } from "react";

/**
 * This route is dark only: a light surface dissolves the wireframe. The dark
 * variant is forced on <html> for as long as the page is mounted, and the
 * reader's stored choice is put back on the way out. The stored preference is
 * never written, so nothing else in the app is affected.
 */
export function useForcedDark() {
  useLayoutEffect(() => {
    const root = document.documentElement;
    const wasDark = root.classList.contains("dark");
    root.classList.add("dark");
    return () => {
      if (!wasDark) root.classList.remove("dark");
    };
  }, []);
}
