import { Moon, Sun } from "lucide-react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { DESIGN_SYSTEMS, type DesignSystemId } from "@/lib/design-systems";
import { cn } from "@/lib/utils";

/** Design-system picker + light/dark toggle. Rendered on the shell, the login
 *  screen and the public share viewer so the choice is one tap away everywhere. */
export function ThemeControls({
  design,
  onDesign,
  isDark,
  onToggle,
  compact = false,
}: {
  design: DesignSystemId;
  onDesign: (value: DesignSystemId) => void;
  isDark: boolean;
  onToggle: () => void;
  compact?: boolean;
}) {
  const active = DESIGN_SYSTEMS.find((system) => system.id === design) ?? DESIGN_SYSTEMS[0];

  return (
    <div className="flex items-center gap-2">
      <div className={cn("relative", compact ? "w-[136px]" : "w-[176px]")}>
        <span
          className="pointer-events-none absolute left-2.5 top-1/2 h-2.5 w-2.5 -translate-y-1/2 rounded-full border border-border"
          style={{ background: active.swatch.accent }}
          aria-hidden="true"
        />
        <Select value={design} onValueChange={(value) => onDesign(value as DesignSystemId)}>
          <SelectTrigger
            data-testid="design-system-picker"
            aria-label="Design system"
            className="h-9 bg-card pl-7 font-display text-xs"
          >
            <SelectValue>{active.name}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            <div className="px-2 py-1.5">
              <p className="eyebrow">Design system</p>
            </div>
            {DESIGN_SYSTEMS.map((system) => (
              <SelectItem key={system.id} value={system.id} textValue={system.name} className="py-2">
                <span className="flex items-center gap-2.5">
                  <span className="flex overflow-hidden rounded-[3px] border border-border" aria-hidden="true">
                    {[system.swatch.bg, system.swatch.surface, system.swatch.accent].map((color) => (
                      <span key={color} className="h-3.5 w-2" style={{ background: color }} />
                    ))}
                  </span>
                  <span className="flex max-w-[220px] flex-col leading-tight">
                    <span className="font-display text-[13px] font-medium">{system.name}</span>
                    <span className="text-[10px] text-muted-foreground">{system.character}</span>
                  </span>
                </span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <Button
        data-testid="theme-toggle"
        variant="outline"
        size="icon"
        className="h-9 w-9 bg-card"
        onClick={onToggle}
        aria-label={isDark ? "Switch to the light variant" : "Switch to the dark variant"}
        title={isDark ? "Light variant" : "Dark variant"}
      >
        {isDark ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
      </Button>
    </div>
  );
}
