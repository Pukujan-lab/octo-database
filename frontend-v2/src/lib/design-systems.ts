export type DesignSystemId = "midnight" | "supabase" | "emerald" | "violet" | "amber" | "paper";
export type ThemeVariant = "dark" | "light";

export type DesignSystem = {
  id: DesignSystemId;
  name: string;
  character: string;
  /** Swatch chips rendered in the picker. These are preview-only literals —
   *  no component chrome reads from this list. */
  swatch: { bg: string; surface: string; accent: string };
};

export const DESIGN_SYSTEMS: DesignSystem[] = [
  {
    id: "midnight",
    name: "Midnight",
    character: "Near-black surfaces, vivid lime signal — Octo's own identity",
    swatch: { bg: "#090D12", surface: "#121923", accent: "#B8F02A" },
  },
  {
    id: "supabase",
    name: "Supabase",
    character: "#1c1c1c-family surfaces with an emerald-green accent",
    swatch: { bg: "#1C1C1C", surface: "#232323", accent: "#3ECF8E" },
  },
  {
    id: "emerald",
    name: "Emerald",
    character: "Cool dark neutrals with a deep green accent",
    swatch: { bg: "#080F12", surface: "#111C21", accent: "#10B981" },
  },
  {
    id: "violet",
    name: "Violet",
    character: "Cool dark neutrals with a violet accent",
    swatch: { bg: "#0B0912", surface: "#151221", accent: "#8B5CF6" },
  },
  {
    id: "amber",
    name: "Amber",
    character: "Warm dark neutrals with an amber accent",
    swatch: { bg: "#100C08", surface: "#1A1512", accent: "#F59E0B" },
  },
  {
    id: "paper",
    name: "Paper",
    character: "Warm, light-first system — cream surfaces, deep teal accent",
    swatch: { bg: "#FAF7F2", surface: "#FFFDF9", accent: "#0F5C55" },
  },
];

export const DESIGN_STORAGE_KEY = "octo_design_system";
export const THEME_STORAGE_KEY = "octo_theme_variant";

export function isDesignSystem(value: string | null): value is DesignSystemId {
  return DESIGN_SYSTEMS.some((system) => system.id === value);
}
