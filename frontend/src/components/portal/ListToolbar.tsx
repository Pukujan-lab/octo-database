import { LayoutGrid, List } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

/** Shared filter + table/cards toggle used by the Access lists. */
export function ListToolbar({
  value,
  onChange,
  placeholder,
  mode,
  onMode,
  right,
}: {
  value: string;
  onChange: (next: string) => void;
  placeholder: string;
  mode: "table" | "cards";
  onMode: (next: "table" | "cards") => void;
  right?: React.ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      {right}
      <div className="relative min-w-[160px] flex-1 sm:max-w-[260px]">
        <Input
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder={placeholder}
          className="h-8 bg-background text-sm"
          aria-label={placeholder}
        />
      </div>
      <div className="flex overflow-hidden rounded-md border border-border">
        {(["table", "cards"] as const).map((option) => {
          const Icon = option === "table" ? List : LayoutGrid;
          return (
            <button
              key={option}
              type="button"
              onClick={() => onMode(option)}
              aria-pressed={mode === option}
              className={cn(
                "flex h-8 items-center gap-1.5 px-2.5 text-xs font-medium capitalize transition-colors",
                mode === option ? "bg-primary text-primary-foreground" : "bg-card text-muted-foreground hover:text-foreground",
              )}
            >
              <Icon className="h-3.5 w-3.5" />
              <span className="hidden sm:inline">{option}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

export function FilterButton({ children, onClick }: { children: React.ReactNode; onClick: () => void }) {
  return (
    <Button size="sm" variant="outline" onClick={onClick} className="h-8 gap-1.5 text-xs">
      {children}
    </Button>
  );
}
