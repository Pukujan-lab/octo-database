import { useCallback, useEffect, useState } from "react";
import {
  DESIGN_STORAGE_KEY,
  THEME_STORAGE_KEY,
  isDesignSystem,
  type DesignSystemId,
  type ThemeVariant,
} from "@/lib/design-systems";

function readDesign(): DesignSystemId {
  try {
    const stored = localStorage.getItem(DESIGN_STORAGE_KEY);
    if (isDesignSystem(stored)) return stored;
  } catch {
    /* ignore */
  }
  return "midnight";
}

function readVariant(): ThemeVariant {
  try {
    const stored = localStorage.getItem(THEME_STORAGE_KEY);
    if (stored === "light" || stored === "dark") return stored;
  } catch {
    /* ignore */
  }
  return "dark";
}

/** Applies the two theme axes to <html> — [data-design] picks the palette,
 *  .dark picks the variant. Persists both choices; every screen (login, shell,
 *  public share viewer) reads from here. */
export function useTheme() {
  const [design, setDesign] = useState<DesignSystemId>(readDesign);
  const [variant, setVariant] = useState<ThemeVariant>(readVariant);

  useEffect(() => {
    const root = document.documentElement;
    root.setAttribute("data-design", design);
    try {
      localStorage.setItem(DESIGN_STORAGE_KEY, design);
    } catch {
      /* ignore */
    }
  }, [design]);

  useEffect(() => {
    const root = document.documentElement;
    root.classList.toggle("dark", variant === "dark");
    try {
      localStorage.setItem(THEME_STORAGE_KEY, variant);
    } catch {
      /* ignore */
    }
  }, [variant]);

  const toggleVariant = useCallback(() => {
    setVariant((current) => (current === "dark" ? "light" : "dark"));
  }, []);

  return { design, setDesign, variant, toggleVariant, isDark: variant === "dark" };
}
