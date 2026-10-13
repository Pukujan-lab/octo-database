import { Panel, StatusPill } from "@/components/portal/Panel";
import { ApiKeysSection } from "@/components/access/ApiKeysSection";
import { SharesSection } from "@/components/access/SharesSection";
import { MfaSection } from "@/components/access/MfaSection";
import { WorkspaceSettingsSection } from "@/components/access/WorkspaceSettingsSection";
import { useConfirmChallenge } from "@/hooks/useConfirmChallenge";
import { useMfaStatus } from "@/hooks/useMfaStatus";
import type { WorkspaceData } from "@/lib/workspace-data";
import type { DeleteWorkspaceResult, MeResponse, Workspace } from "@/lib/types";
import { formatClock } from "@/lib/format";
import { Clock } from "lucide-react";

/** §8 — credentials, shares, two-factor and workspace settings. A fresh
 *  confirmation code is requested as soon as this view is opened. */
export function AccessView({
  workspace,
  data,
  me,
  remainingMs,
  onRefreshMe,
  onWorkspaceDeleted,
}: {
  workspace: Workspace;
  data: WorkspaceData;
  me: MeResponse | null;
  remainingMs: number;
  onRefreshMe: () => void;
  onWorkspaceDeleted: (result: DeleteWorkspaceResult) => void;
}) {
  const challenge = useConfirmChallenge(true);
  const mfaStatus = useMfaStatus(true);

  return (
    <div data-testid="view-access" className="animate-fade-rise space-y-6">
      <Panel
        eyebrow="Session"
        title="Security posture"
        action={
          <StatusPill tone="muted" className="gap-1.5">
            <Clock className="h-3 w-3" /> {formatClock(remainingMs)} left
          </StatusPill>
        }
      >
        <div className="grid gap-px bg-border sm:grid-cols-2 lg:grid-cols-4">
          <Cell label="Principal" value={me?.principal.displayName ?? "—"} sub={me?.principal.email ?? (me?.principal.isGuest ? "guest" : undefined)} />
          <Cell
            label="Confirmation secret"
            value={me?.confirmSecretSet ? "Set" : "Not set"}
            tone={me?.confirmSecretSet ? "success" : "warning"}
            sub="Gates destructive calls"
          />
          <Cell
            label="Two-factor"
            value={me?.mfaEnabled ? "Enabled" : "Disabled"}
            tone={me?.mfaEnabled ? "success" : "warning"}
            sub={me?.mfaEnabled ? `${me.mfaRecoveryCodesRemaining} recovery codes left` : "Step-up not required"}
          />
          <Cell
            label="Confirmation code"
            value={challenge.code ?? (challenge.loading ? "Requesting…" : "Unavailable")}
            tone={challenge.code ? "primary" : "warning"}
            sub="Single-use, typed into gated forms"
          />
        </div>
      </Panel>

      <ApiKeysSection
        workspaceId={workspace.id}
        workspaceName={workspace.name}
        query={data.keys}
        me={me}
        code={challenge.code}
        codeLoading={challenge.loading}
        codeError={challenge.error}
        refreshCode={challenge.refresh}
        reload={data.reload}
      />

      <SharesSection workspaceId={workspace.id} query={data.shares} reload={data.reload} />

      <MfaSection me={me} status={mfaStatus.data ?? null} onUpdated={() => { mfaStatus.refetch(); onRefreshMe(); }} />

      <WorkspaceSettingsSection
        workspace={workspace}
        me={me}
        code={challenge.code}
        codeLoading={challenge.loading}
        codeError={challenge.error}
        refreshCode={challenge.refresh}
        onDeleted={onWorkspaceDeleted}
        onRotateSecret={onRefreshMe}
      />
    </div>
  );
}

function Cell({
  label,
  value,
  sub,
  tone = "default",
}: {
  label: string;
  value: string;
  sub?: string;
  tone?: "default" | "success" | "warning" | "primary";
}) {
  const toneClass =
    tone === "success"
      ? "text-success"
      : tone === "warning"
        ? "text-warning"
        : tone === "primary"
          ? "text-primary"
          : "text-foreground";
  return (
    <div className="bg-card px-5 py-4">
      <p className="eyebrow">{label}</p>
      <p className={"mt-1.5 truncate font-display text-sm font-semibold " + toneClass}>{value}</p>
      {sub ? <p className="mt-0.5 truncate text-[11px] text-muted-foreground">{sub}</p> : null}
    </div>
  );
}
