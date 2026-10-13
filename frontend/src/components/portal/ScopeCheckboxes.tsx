import { KEY_SCOPES } from "@/lib/types";

/** Allowance editor over the four documented scopes: read, write, files, delete. */
export function ScopeCheckboxes({
  value,
  onChange,
  idPrefix,
}: {
  value: string[];
  onChange: (next: string[]) => void;
  idPrefix: string;
}) {
  return (
    <div className="flex flex-wrap gap-x-5 gap-y-2">
      {KEY_SCOPES.map((scope) => {
        const id = `${idPrefix}-scope-${scope}`;
        const checked = value.includes(scope);
        return (
          <label key={scope} htmlFor={id} className="flex cursor-pointer select-none items-center gap-2 text-sm">
            <input
              id={id}
              type="checkbox"
              checked={checked}
              onChange={(event) =>
                onChange(event.target.checked ? [...value, scope] : value.filter((item) => item !== scope))
              }
              className="peer sr-only"
            />
            <span
              aria-hidden="true"
              className="flex h-4 w-4 items-center justify-center rounded-[3px] border border-input bg-background transition-colors peer-checked:border-primary peer-checked:bg-primary peer-focus-visible:ring-2 peer-focus-visible:ring-ring peer-focus-visible:ring-offset-2 peer-focus-visible:ring-offset-background"
            >
              {checked ? (
                <svg viewBox="0 0 12 12" className="h-3 w-3 text-primary-foreground">
                  <path
                    d="M2.5 6.2l2.3 2.3 4.7-5"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.8"
                    strokeLinecap="round"
                  />
                </svg>
              ) : null}
            </span>
            <span className="num text-[13px] font-medium">{scope}</span>
          </label>
        );
      })}
    </div>
  );
}

export function ScopeSummary({ scopes }: { scopes: string[] }) {
  if (!scopes.length) return <span className="text-xs text-muted-foreground">no allowances</span>;
  return (
    <span className="flex flex-wrap gap-1">
      {scopes.map((scope) => (
        <span key={scope} className="num rounded border border-border bg-secondary px-1.5 py-0.5 text-[11px]">
          {scope}
        </span>
      ))}
    </span>
  );
}
