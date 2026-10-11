import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Panel, StatusPill } from "./Panel";
import { cn } from "@/lib/utils";
import { formatClock } from "@/lib/format";
import type { Principal, Workspace } from "@/lib/types";
import {
  ChevronDown,
  Clock,
  FolderOpen,
  Hexagon,
  Images,
  LayoutDashboard,
  LogOut,
  Plus,
  Shield,
  Workflow,
} from "lucide-react";

export type ViewId = "overview" | "files" | "gallery" | "operations" | "access";

export const VIEWS: Array<{ id: ViewId; label: string; icon: typeof LayoutDashboard }> = [
  { id: "overview", label: "Overview", icon: LayoutDashboard },
  { id: "files", label: "Files", icon: FolderOpen },
  { id: "gallery", label: "Gallery", icon: Images },
  { id: "operations", label: "Operations", icon: Workflow },
  { id: "access", label: "Access", icon: Shield },
];

export function AppShell({
  workspaces,
  workspace,
  onSelectWorkspace,
  principal,
  onSignOut,
  remainingMs,
  onNewWorkspace,
  activeView,
  onViewChange,
  themeControls,
  children,
}: {
  workspaces: Workspace[];
  workspace: Workspace | null;
  onSelectWorkspace: (id: string) => void;
  principal: Principal | null;
  onSignOut: () => void;
  remainingMs: number;
  onNewWorkspace: () => void;
  activeView: ViewId;
  onViewChange: (view: ViewId) => void;
  themeControls: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="relative min-h-dvh bg-background text-foreground">
      <div className="motif-glow pointer-events-none fixed inset-x-0 top-0 h-[420px] opacity-70" aria-hidden="true" />

      <div className="relative mx-auto flex min-h-dvh w-full max-w-[1560px] flex-col lg:flex-row">
        {/* --------------------------------------------------------- sidebar */}
        <aside
          data-testid="app-nav"
          className="z-30 flex shrink-0 flex-col gap-5 border-b border-sidebar-border bg-sidebar px-4 py-4 text-sidebar-foreground lg:sticky lg:top-0 lg:h-dvh lg:w-[272px] lg:gap-6 lg:border-b-0 lg:border-r lg:px-5 lg:py-6"
        >
          <div className="flex items-center gap-2.5">
            <span className="flex h-9 w-9 items-center justify-center rounded-md bg-sidebar-primary/12 ring-1 ring-sidebar-primary/30">
              <Hexagon className="h-4 w-4 text-sidebar-primary" strokeWidth={1.9} />
            </span>
            <div className="leading-tight">
              <p className="font-display text-[13px] font-semibold uppercase tracking-[0.18em]">Octo</p>
              <p className="text-[10px] uppercase tracking-[0.2em] text-muted-foreground">portal</p>
            </div>
          </div>

          <nav className="flex gap-1 overflow-x-auto pb-1 lg:flex-col lg:overflow-visible lg:pb-0">
            {VIEWS.map((view) => {
              const Icon = view.icon;
              const active = view.id === activeView;
              return (
                <button
                  key={view.id}
                  type="button"
                  onClick={() => onViewChange(view.id)}
                  aria-current={active ? "page" : undefined}
                  className={cn(
                    "flex shrink-0 items-center gap-2.5 rounded-md px-3 py-2 text-left text-sm font-medium transition-colors lg:w-full",
                    active
                      ? "bg-sidebar-primary text-sidebar-primary-foreground"
                      : "text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
                  )}
                >
                  <Icon className={cn("h-4 w-4 shrink-0", active ? "opacity-100" : "opacity-60")} />
                  <span className="whitespace-nowrap">{view.label}</span>
                  {active ? <span className="ml-auto hidden h-1.5 w-1.5 rounded-full bg-current lg:block" /> : null}
                </button>
              );
            })}
          </nav>

          <div className="hidden space-y-2 lg:block">
            <p className="eyebrow">Active workspace</p>
            <div className="rounded-md border border-sidebar-border bg-sidebar-accent/45 p-3">
              {workspace ? (
                <div className="space-y-0.5">
                  <p className="truncate font-display text-sm font-semibold">{workspace.name}</p>
                  <p className="num truncate text-[11px] text-muted-foreground">/{workspace.slug}</p>
                  <div className="flex flex-wrap items-center gap-1.5 pt-2">
                    {workspace.isOwner ? (
                      <StatusPill tone="primary">owner</StatusPill>
                    ) : (
                      <StatusPill tone="muted">{workspace.role}</StatusPill>
                    )}
                  </div>
                </div>
              ) : (
                <p className="text-xs text-muted-foreground">No workspace selected</p>
              )}
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={onNewWorkspace}
                className="mt-2 h-7 w-full justify-start gap-1.5 px-2 text-xs text-sidebar-primary hover:bg-sidebar-accent"
              >
                <Plus className="h-3.5 w-3.5" /> New workspace
              </Button>
            </div>
          </div>

          <div className="mt-auto hidden items-center gap-3 border-t border-sidebar-border pt-4 lg:flex">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-sidebar-accent font-display text-xs font-semibold uppercase">
              {(principal?.displayName ?? "?").slice(0, 2)}
            </span>
            <div className="min-w-0 flex-1 leading-tight">
              <p className="truncate text-sm font-medium">{principal?.displayName || "Signed in"}</p>
              <p className="num flex items-center gap-1 truncate text-[11px] text-muted-foreground">
                <Clock className="h-3 w-3" /> {formatClock(remainingMs)} left
              </p>
            </div>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              onClick={onSignOut}
              aria-label="Sign out"
              title="Sign out"
              className="h-8 w-8 text-muted-foreground hover:text-foreground"
            >
              <LogOut className="h-4 w-4" />
            </Button>
          </div>
        </aside>

        {/* ------------------------------------------------------------ main */}
        <div className="flex min-w-0 flex-1 flex-col">
          <header className="z-20 flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-border bg-background/92 px-4 py-3 sm:px-6 lg:sticky lg:top-0 lg:py-4">
            <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2.5">
              <h1 className="truncate font-display text-lg font-semibold tracking-tight sm:text-xl">
                {workspace?.name ?? "No workspace"}
              </h1>
              {workspace ? <StatusPill tone="primary">{workspace.role}</StatusPill> : null}
              {principal?.isGuest ? (
                <StatusPill tone="warning" dot>
                  guest session
                </StatusPill>
              ) : null}
              <span className="num hidden items-center gap-1 text-[11px] text-muted-foreground xl:flex">
                <Clock className="h-3 w-3" /> {formatClock(remainingMs)} in session
              </span>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <label className="sr-only" htmlFor="workspace-picker">
                Workspace
              </label>
              <div className="relative">
                <select
                  id="workspace-picker"
                  data-testid="workspace-picker"
                  value={workspace?.id ?? ""}
                  onChange={(event) => onSelectWorkspace(event.target.value)}
                  className="h-9 w-[150px] cursor-pointer appearance-none truncate rounded-md border border-input bg-card pl-3 pr-8 text-sm font-medium text-foreground transition-colors hover:border-ring sm:w-[210px]"
                >
                  {workspaces.length === 0 ? <option value="">No workspaces</option> : null}
                  {workspaces.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.name} — /{item.slug}
                    </option>
                  ))}
                </select>
                <ChevronDown className="pointer-events-none absolute right-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              </div>

              <Button type="button" size="sm" variant="outline" onClick={onNewWorkspace} className="h-9 gap-1.5">
                <Plus className="h-4 w-4" />
                <span className="hidden sm:inline">New Workspace</span>
              </Button>

              {themeControls}

              <div className="flex items-center gap-2 lg:hidden">
                <span className="num text-[11px] text-muted-foreground">{formatClock(remainingMs)}</span>
                <Button type="button" size="icon" variant="outline" className="h-9 w-9" onClick={onSignOut} aria-label="Sign out">
                  <LogOut className="h-4 w-4" />
                </Button>
              </div>
            </div>
          </header>

          <main className="flex-1 px-4 py-6 sm:px-6 sm:py-8">{children}</main>
        </div>
      </div>
    </div>
  );
}
