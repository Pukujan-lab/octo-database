import { useCallback, useEffect, useMemo, useState } from "react";
import { useSession } from "@/hooks/useSession";
import { useTheme } from "@/hooks/useTheme";
import { useHealth, useWorkspaces } from "@/lib/queries";
import { useWorkspaceData } from "@/lib/workspace-data";
import { AppShell, type ViewId } from "@/components/portal/AppShell";
import { LoginScreen } from "@/components/portal/LoginScreen";
import { ThemeControls } from "@/components/portal/ThemeControls";
import { CreateWorkspaceDialog } from "@/components/portal/CreateWorkspaceDialog";
import { EmptyState } from "@/components/portal/EmptyState";
import { Panel } from "@/components/portal/Panel";
import { Button } from "@/components/ui/button";
import { OverviewView } from "@/views/OverviewView";
import { FilesView } from "@/views/FilesView";
import { GalleryView } from "@/views/GalleryView";
import { OperationsView } from "@/views/OperationsView";
import { AnalyticsView } from "@/views/AnalyticsView";
import { ServicesView } from "@/views/ServicesView";
import { AccessView } from "@/views/AccessView";
import { VaultView } from "@/views/VaultView";
import type { DeleteWorkspaceResult } from "@/lib/types";

export default function Index() {
  const theme = useTheme();
  const session = useSession();
  const health = useHealth();
  const signedIn = session.status !== "signed-out";

  const workspacesQuery = useWorkspaces(signedIn);
  const workspaces = useMemo(() => workspacesQuery.data ?? [], [workspacesQuery.data]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [view, setView] = useState<ViewId>("overview");
  const [createOpen, setCreateOpen] = useState(false);

  // The first workspace is active on entry; keep the selection valid as the list changes.
  useEffect(() => {
    if (!workspaces.length) {
      setActiveId(null);
      return;
    }
    setActiveId((current) =>
      current && workspaces.some((item) => item.id === current) ? current : workspaces[0].id,
    );
  }, [workspaces]);

  const workspace = workspaces.find((item) => item.id === activeId) ?? null;
  const data = useWorkspaceData(workspace?.id ?? "");

  const handleDeleted = useCallback(
    (result: DeleteWorkspaceResult) => {
      const remaining = workspaces.filter((item) => item.id !== result.workspaceId);
      setActiveId(remaining[0]?.id ?? null);
      setView("overview");
      void workspacesQuery.refetch();
      if (!remaining.length) session.signOut();
    },
    [workspaces, workspacesQuery, session],
  );

  const themeControls = (
    <ThemeControls
      design={theme.design}
      onDesign={theme.setDesign}
      isDark={theme.isDark}
      onToggle={theme.toggleVariant}
      compact
    />
  );

  if (session.status === "signed-out") {
    return (
      <LoginScreen
        health={health.data}
        healthPending={health.isPending}
        notice={session.notice}
        signingIn={session.signingIn}
        onGuest={session.signInWithGuest}
        designControls={themeControls}
        isDark={theme.isDark}
      />
    );
  }

  if (session.status === "restoring") {
    return (
      <div className="flex min-h-dvh items-center justify-center bg-background">
        <div className="space-y-5 text-center">
          <div className="motif-orb mx-auto h-16 w-16 animate-pulse-ring rounded-full" />
          <p className="eyebrow">restoring session</p>
          <p className="text-xs text-muted-foreground">Checking your token against the Octo API…</p>
        </div>
      </div>
    );
  }

  if (session.meError) {
    return (
      <div className="mx-auto flex min-h-dvh max-w-lg items-center px-5">
        <Panel className="w-full">
          <EmptyState
            title="Session could not be restored"
            description={session.meError}
            action={<Button onClick={session.signOut}>Back to sign in</Button>}
          />
        </Panel>
      </div>
    );
  }

  return (
    <>
      <AppShell
        workspaces={workspaces}
        workspace={workspace}
        onSelectWorkspace={setActiveId}
        principal={session.principal}
        onSignOut={session.signOut}
        remainingMs={session.remainingMs}
        onNewWorkspace={() => setCreateOpen(true)}
        activeView={view}
        onViewChange={setView}
        themeControls={themeControls}
      >
        {workspacesQuery.isError ? (
          <Panel>
            <EmptyState
              title="Could not load your workspaces"
              description="The portal cannot reach the workspace list. Retry, or sign in again if your session changed."
              action={<Button onClick={() => workspacesQuery.refetch()}>Retry</Button>}
            />
          </Panel>
        ) : workspacesQuery.isPending ? (
          <Panel>
            <div className="space-y-3 p-8">
              <div className="h-4 w-40 animate-pulse rounded bg-muted" />
              <div className="h-4 w-72 animate-pulse rounded bg-muted" />
              <div className="h-4 w-56 animate-pulse rounded bg-muted" />
            </div>
          </Panel>
        ) : !workspace && view !== "vault" ? (
          <Panel>
            <EmptyState
              title="No workspaces yet"
              description="Create your first workspace to start storing files, media and jobs. Creating one is gated behind a confirmation code. Account keys can be stored from Keys before a workspace exists."
              action={<Button onClick={() => setCreateOpen(true)}>+ New Workspace</Button>}
            />
          </Panel>
        ) : view === "vault" ? (
          <VaultView workspace={workspace} me={session.me} />
        ) : !workspace ? null : (
          <>
            {data.failedSections.length && view !== "overview" ? (
              <div className="panel mb-6 border-warning/45 bg-warning/8 px-5 py-3 text-sm text-warning">
                Could not load {data.failedSections.join(", ")} for this workspace
              </div>
            ) : null}
            {view === "overview" ? (
              <OverviewView
                workspace={workspace}
                data={data}
                isGuest={Boolean(session.principal?.isGuest)}
                onNavigate={setView}
              />
            ) : null}
            {view === "files" ? <FilesView workspaceId={workspace.id} data={data} /> : null}
            {view === "gallery" ? <GalleryView workspaceId={workspace.id} data={data} /> : null}
            {view === "operations" ? <OperationsView workspaceId={workspace.id} data={data} /> : null}
            {view === "analytics" ? <AnalyticsView workspaceId={workspace.id} /> : null}
            {view === "services" ? <ServicesView workspaceId={workspace.id} /> : null}
            {view === "access" ? (
              <AccessView
                workspace={workspace}
                data={data}
                me={session.me}
                remainingMs={session.remainingMs}
                onRefreshMe={() => void session.refreshMe()}
                onWorkspaceDeleted={handleDeleted}
              />
            ) : null}
          </>
        )}
      </AppShell>

      <CreateWorkspaceDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        me={session.me}
        onCreated={(created) => {
          void workspacesQuery.refetch();
          setActiveId(created.id);
          setView("overview");
        }}
      />
    </>
  );
}
