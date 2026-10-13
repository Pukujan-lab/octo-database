import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { api, errorMessage } from "@/lib/api";
import { toast } from "@/utils/toast";
import { ShieldCheck } from "lucide-react";

/** The first-time setup for the confirm-code gate: the account has no
 *  confirmation secret yet, so the server refuses gated calls with 412. */
export function ConfirmSecretDialog({
  open,
  onOpenChange,
  onDone,
  rotated = false,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDone: () => void;
  rotated?: boolean;
}) {
  const [secret, setSecret] = useState("");
  const [currentSecret, setCurrentSecret] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit() {
    if (secret.length < 8) {
      toast.error("Use at least 8 characters");
      return;
    }
    setBusy(true);
    try {
      const result = await api.post<{ success: boolean; rotated: boolean }>("/api/me/confirm-secret", {
        secret,
        currentSecret: rotated ? currentSecret : undefined,
      });
      toast.success(result.rotated ? "Confirmation secret rotated" : "Confirmation secret set");
      setSecret("");
      setCurrentSecret("");
      onOpenChange(false);
      onDone();
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ShieldCheck className="h-4 w-4 text-primary" />
            {rotated ? "Rotate confirmation secret" : "Set a confirmation secret"}
          </DialogTitle>
          <DialogDescription>
            {rotated
              ? "Choose a new phrase. Destructive actions are confirmed by typing a code derived from it."
              : "Destructive and credential-creating actions are gated behind a code only you can type. Choose the phrase that gates them (minimum 8 characters)."}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          {rotated ? (
            <div className="space-y-1.5">
              <Label htmlFor="current-confirm-secret">Current secret</Label>
              <Input
                id="current-confirm-secret"
                type="password"
                autoComplete="current-password"
                value={currentSecret}
                onChange={(event) => setCurrentSecret(event.target.value)}
              />
            </div>
          ) : null}
          <div className="space-y-1.5">
            <Label htmlFor="new-confirm-secret">{rotated ? "New secret" : "Secret"}</Label>
            <Input
              id="new-confirm-secret"
              type="password"
              autoComplete="new-password"
              placeholder="at least 8 characters"
              value={secret}
              onChange={(event) => setSecret(event.target.value)}
            />
            <p className="num text-[11px] text-muted-foreground">{secret.length} / 8 minimum</p>
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={() => void submit()} disabled={busy || secret.length < 8}>
            {busy ? "Saving…" : rotated ? "Rotate secret" : "Save secret"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
