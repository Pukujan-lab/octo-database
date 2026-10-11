import { useCallback, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { ConfirmGate } from "./ConfirmGate";
import { OneTimeSecret } from "./OneTimeSecret";
import { ConfirmSecretDialog } from "./ConfirmSecretDialog";
import { useConfirmChallenge } from "@/hooks/useConfirmChallenge";
import { api, errorCode, errorMessage, isConfirmSecretMissing } from "@/lib/api";
import type { ApiKey, MeResponse, Workspace } from "@/lib/types";
import { toast } from "@/utils/toast";

/** §7 create-workspace form — gated by the confirmation code, and by MFA when
 *  the principal has two-factor enabled. */
export function CreateWorkspaceDialog({
  open,
  onOpenChange,
  me,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  me: MeResponse | null;
  onCreated: (workspace: Workspace) => void;
}) {
  const challenge = useConfirmChallenge(open);
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [description, setDescription] = useState("");
  const [retention, setRetention] = useState("");
  const [code, setCode] = useState("");
  const [mfaCode, setMfaCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [needSecret, setNeedSecret] = useState(false);
  const [created, setCreated] = useState<{ workspace: Workspace; rawSecret: string } | null>(null);

  /** Closing the form always discards the one-time workspace key. */
  const handleOpenChange = useCallback(
    (next: boolean) => {
      if (!next) setCreated(null);
      onOpenChange(next);
    },
    [onOpenChange],
  );

  async function submit() {
    if (!name.trim()) {
      toast.error("Give the workspace a name");
      return;
    }
    setBusy(true);
    try {
      const result = await api.post<{ workspace: Workspace; apiKey: ApiKey; rawSecret: string }>("/api/workspaces", {
        name: name.trim(),
        slug: slug.trim() || undefined,
        description: description.trim() || undefined,
        retentionDays: retention ? Number(retention) : undefined,
        confirmSecret: code,
        mfaCode: me?.mfaEnabled ? mfaCode : undefined,
      });
      toast.success(`Workspace ${result.workspace.name} created`);
      setCreated({ workspace: result.workspace, rawSecret: result.rawSecret });
      setName("");
      setSlug("");
      setDescription("");
      setRetention("");
      setCode("");
      onCreated(result.workspace);
    } catch (error) {
      if (isConfirmSecretMissing(error)) {
        setNeedSecret(true);
        toast.error("Set a confirmation secret before creating workspaces");
      } else if (errorCode(error) === "SLUG_TAKEN") {
        toast.error("That slug is already taken");
      } else if (errorCode(error) === "WORKSPACE_DAILY_LIMIT") {
        toast.error("This account has used its workspace allowance for today");
      } else {
        toast.error(errorMessage(error));
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Dialog open={open} onOpenChange={handleOpenChange}>
        <DialogContent className="max-w-xl">
          <DialogHeader>
            <DialogTitle>New workspace</DialogTitle>
            <DialogDescription>
              Creates an isolated namespace for files, media and jobs. A workspace key is minted with
              it and shown once.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            {created ? (
              <OneTimeSecret
                label="Workspace key"
                value={created.rawSecret}
                hint="Store it in your secret manager now — Octo keeps only the prefix."
                onDismiss={() => setCreated(null)}
              />
            ) : null}

            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="ws-name">Name</Label>
                <Input id="ws-name" value={name} onChange={(event) => setName(event.target.value)} placeholder="Acme analytics" />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="ws-slug">
                  Slug <span className="text-muted-foreground">(optional)</span>
                </Label>
                <Input id="ws-slug" value={slug} onChange={(event) => setSlug(event.target.value)} placeholder="acme-analytics" className="num" />
              </div>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="ws-description">Description</Label>
              <Textarea
                id="ws-description"
                rows={2}
                value={description}
                onChange={(event) => setDescription(event.target.value)}
                placeholder="What lives in this workspace?"
              />
            </div>

            <div className="grid gap-4 sm:grid-cols-[minmax(0,200px)_1fr] sm:items-end">
              <div className="space-y-1.5">
                <Label htmlFor="ws-retention">File retention (days)</Label>
                <Input
                  id="ws-retention"
                  type="number"
                  min={1}
                  value={retention}
                  onChange={(event) => setRetention(event.target.value)}
                  placeholder="Server default"
                  className="num"
                />
              </div>
              <p className="text-xs leading-relaxed text-muted-foreground">
                Objects older than this become archive candidates and are moved to cold storage by a
                background job.
              </p>
            </div>

            <ConfirmGate
              code={challenge.code}
              loading={challenge.loading}
              error={challenge.error}
              onRefresh={challenge.refresh}
              value={code}
              onChange={setCode}
              mfaEnabled={Boolean(me?.mfaEnabled)}
              mfaValue={mfaCode}
              onMfaChange={setMfaCode}
            />
          </div>

          <DialogFooter>
            <Button variant="ghost" onClick={() => handleOpenChange(false)}>
              Close
            </Button>
            <Button onClick={() => void submit()} disabled={busy}>
              {busy ? "Creating…" : "Create workspace"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmSecretDialog open={needSecret} onOpenChange={setNeedSecret} onDone={challenge.refresh} />
    </>
  );
}
