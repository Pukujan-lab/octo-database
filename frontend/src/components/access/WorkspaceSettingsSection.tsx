import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Panel, StatusPill } from "@/components/portal/Panel";
import { ConfirmGate } from "@/components/portal/ConfirmGate";
import { ConfirmSecretDialog } from "@/components/portal/ConfirmSecretDialog";
import { api, errorMessage, isConfirmSecretMissing } from "@/lib/api";
import { useConfirmWindow } from "@/lib/confirm-window";
import type { DeleteWorkspaceResult, MeResponse, Workspace } from "@/lib/types";
import { formatCount } from "@/lib/format";
import { AlertOctagon, Trash2 } from "lucide-react";
import { toast } from "@/utils/toast";

/** §8.4 Workspace settings + the slug-typed delete flow. */
export function WorkspaceSettingsSection({
  workspace,
  me,
  code,
  codeLoading,
  codeError,
  refreshCode,
  onDeleted,
  onRotateSecret,
}: {
  workspace: Workspace;
  me: MeResponse | null;
  code: string | null;
  codeLoading: boolean;
  codeError: string | null;
  refreshCode: () => void;
  onDeleted: (result: DeleteWorkspaceResult) => void;
  onRotateSecret: () => void;
}) {
  const [armed, setArmed] = useState(false);
  const [slugInput, setSlugInput] = useState("");
  const [typed, setTyped] = useState("");
  const [mfaCode, setMfaCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [rotateOpen, setRotateOpen] = useState(false);
  const windowLeft = useConfirmWindow();

  async function destroy() {
    if (slugInput.trim() !== workspace.slug) {
      toast.error("Type the slug exactly to confirm deletion");
      return;
    }
    setBusy(true);
    try {
      const result = await api.del<DeleteWorkspaceResult>(`/api/workspaces/${workspace.id}`, {
        confirmSecret: typed,
        confirmSlug: slugInput.trim(),
        mfaCode: me?.mfaEnabled ? mfaCode : undefined,
      });
      toast.success(`Workspace ${result.slug} deleted`);
      setArmed(false);
      setSlugInput("");
      setTyped("");
      setMfaCode("");
      onDeleted(result);
    } catch (error) {
      if (isConfirmSecretMissing(error)) setRotateOpen(true);
      else toast.error(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Panel
      eyebrow="Workspace"
      title="Settings"
      action={<StatusPill tone={workspace.isOwner ? "primary" : "muted"}>{workspace.role}</StatusPill>}
    >
      <div className="space-y-6 p-5">
        <dl className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
          <Field label="Name">{workspace.name}</Field>
          <Field label="Slug">
            <span className="num">{workspace.slug}</span>
          </Field>
          <Field label="Workspace id">
            <span className="num break-all text-xs">{workspace.id}</span>
          </Field>
          <Field label="File retention">
            {workspace.retentionDays ? `${workspace.retentionDays} days` : "Server default"}
          </Field>
          <Field label="Confirmation secret">
            {me?.confirmSecretSet ? (
              <span className="flex items-center gap-2">
                <StatusPill tone="success" dot>
                  set
                </StatusPill>
                <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" onClick={() => setRotateOpen(true)}>
                  Rotate
                </Button>
              </span>
            ) : (
              <span className="flex items-center gap-2">
                <StatusPill tone="warning" dot>
                  not set
                </StatusPill>
                <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" onClick={() => setRotateOpen(true)}>
                  Set now
                </Button>
              </span>
            )}
          </Field>
          <Field label="Two-factor">
            {me?.mfaEnabled ? (
              <StatusPill tone="success" dot>
                enabled · {formatCount(me?.mfaRecoveryCodesRemaining ?? 0)} codes left
              </StatusPill>
            ) : (
              <StatusPill tone="warning" dot>
                disabled
              </StatusPill>
            )}
          </Field>
          <div className="sm:col-span-2 lg:col-span-3">
            <Field label="Description">{workspace.description?.trim() || "No description"}</Field>
          </div>
        </dl>

        <div className="space-y-3 rounded-lg border border-destructive/40 bg-destructive/5 p-4">
          <div className="flex items-center gap-2">
            <AlertOctagon className="h-4 w-4 text-destructive" />
            <p className="eyebrow text-destructive">Danger zone</p>
          </div>
          <p className="text-sm leading-relaxed text-muted-foreground">
            Deleting {workspace.name} removes its catalog, gallery index, jobs and share links. Objects
            that are no longer referenced are reported as orphaned rather than silently purged.
          </p>

          {armed ? (
            <div className="space-y-4">
              <div className="space-y-1.5">
                <Label htmlFor="delete-slug">
                  Type <span className="num text-foreground">{workspace.slug}</span> to confirm
                </Label>
                <Input
                  id="delete-slug"
                  value={slugInput}
                  onChange={(event) => setSlugInput(event.target.value)}
                  placeholder={workspace.slug}
                  className="num bg-background"
                />
              </div>
              <ConfirmGate
                code={code}
                loading={codeLoading}
                error={codeError}
                onRefresh={refreshCode}
                value={typed}
                onChange={setTyped}
                mfaEnabled={Boolean(me?.mfaEnabled)}
                mfaValue={mfaCode}
                onMfaChange={setMfaCode}
              />
              <div className="flex flex-wrap gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    setArmed(false);
                    setSlugInput("");
                  }}
                >
                  Cancel
                </Button>
                <Button
                  size="sm"
                  onClick={() => void destroy()}
                  disabled={busy || slugInput.trim() !== workspace.slug || (!typed && windowLeft === 0)}
                  className="gap-2 bg-destructive text-destructive-foreground hover:bg-destructive/90"
                >
                  <Trash2 className="h-4 w-4" /> {busy ? "Deleting…" : `Delete ${workspace.name}`}
                </Button>
              </div>
            </div>
          ) : (
            <Button size="sm" variant="outline" onClick={() => setArmed(true)} className="gap-2 border-destructive/50 text-destructive hover:bg-destructive/10 hover:text-destructive">
              <Trash2 className="h-4 w-4" /> Delete workspace
            </Button>
          )}
        </div>
      </div>

      <ConfirmSecretDialog
        open={rotateOpen}
        onOpenChange={setRotateOpen}
        rotated={Boolean(me?.confirmSecretSet)}
        onDone={() => {
          refreshCode();
          onRotateSecret();
        }}
      />
    </Panel>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <dt className="eyebrow">{label}</dt>
      <dd className="text-sm leading-relaxed">{children}</dd>
    </div>
  );
}
