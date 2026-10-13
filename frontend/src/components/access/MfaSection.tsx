import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Panel, StatusPill } from "@/components/portal/Panel";
import { api, errorMessage } from "@/lib/api";
import type { MeResponse, MfaStatus } from "@/lib/types";
import { KeyRound, RefreshCw, ShieldCheck, ShieldOff } from "lucide-react";
import { toast } from "@/utils/toast";

/** §8.3 Two-factor: begin -> show secret -> confirm -> recovery codes once. */
export function MfaSection({
  me,
  status,
  onUpdated,
}: {
  me: MeResponse | null;
  status: MfaStatus | null;
  onUpdated: () => void;
}) {
  const enabled = Boolean(me?.mfaEnabled);
  const [setup, setSetup] = useState<{ secret: string; otpauthUri: string } | null>(null);
  const [code, setCode] = useState("");
  const [recoveryCodes, setRecoveryCodes] = useState<string[] | null>(null);
  const [busy, setBusy] = useState<"begin" | "confirm" | "disable" | "rotate" | null>(null);

  async function begin() {
    setBusy("begin");
    try {
      const result = await api.post<{ secret: string; otpauthUri: string }>("/api/me/mfa/begin", {});
      setSetup(result);
      setRecoveryCodes(null);
      setCode("");
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setBusy(null);
    }
  }

  async function confirm() {
    if (code.trim().length < 6) {
      toast.error("Enter the 6-digit code from your authenticator");
      return;
    }
    setBusy("confirm");
    try {
      const result = await api.post<{ recoveryCodes: string[] }>("/api/me/mfa/confirm", { code: code.trim() });
      setRecoveryCodes(result.recoveryCodes ?? []);
      setSetup(null);
      setCode("");
      toast.success("Two-factor enabled");
      onUpdated();
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setBusy(null);
    }
  }

  async function rotateCodes() {
    if (code.trim().length < 6) {
      toast.error("Enter your current authenticator code first");
      return;
    }
    setBusy("rotate");
    try {
      const result = await api.post<{ recoveryCodes: string[] }>("/api/me/mfa/recovery-codes", { code: code.trim() });
      setRecoveryCodes(result.recoveryCodes ?? []);
      setCode("");
      toast.success("New recovery codes issued — the old ones no longer work");
      onUpdated();
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setBusy(null);
    }
  }

  async function disable() {
    if (code.trim().length < 6) {
      toast.error("Enter your authenticator or a recovery code");
      return;
    }
    setBusy("disable");
    try {
      await api.post<{ disabled: boolean }>("/api/me/mfa/disable", { code: code.trim() });
      setCode("");
      setRecoveryCodes(null);
      toast.success("Two-factor disabled");
      onUpdated();
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setBusy(null);
    }
  }

  return (
    <Panel
      eyebrow="Account security"
      title="Two-factor authentication"
      action={
        <StatusPill tone={enabled ? "success" : "warning"} dot>
          {enabled ? "enabled" : "not enabled"}
        </StatusPill>
      }
    >
      <div className="space-y-5 p-5">
        {enabled ? (
          <div className="space-y-3">
            <p className="text-sm leading-relaxed text-muted-foreground">
              Your account requires an authenticator code for destructive actions.{" "}
              <span className="num text-foreground">
                {status?.recoveryCodesRemaining ?? me?.mfaRecoveryCodesRemaining ?? 0}
              </span>{" "}
              recovery code{((status?.recoveryCodesRemaining ?? me?.mfaRecoveryCodesRemaining ?? 0) === 1) ? "" : "s"} remain
              {status?.confirmedAt ? ` · enabled ${status.confirmedAt.slice(0, 10)}` : ""}.
            </p>
            <div className="grid gap-4 sm:grid-cols-[minmax(0,220px)_auto] sm:items-end">
              <div className="space-y-1.5">
                <Label htmlFor="mfa-current">Authenticator or recovery code</Label>
                <Input
                  id="mfa-current"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  maxLength={12}
                  value={code}
                  onChange={(event) => setCode(event.target.value)}
                  placeholder="123456"
                  className="num tracking-[0.2em]"
                />
              </div>
              <div className="flex flex-wrap gap-2">
                <Button size="sm" variant="outline" onClick={() => void rotateCodes()} disabled={busy !== null} className="gap-2">
                  <RefreshCw className="h-4 w-4" /> {busy === "rotate" ? "Rotating…" : "Rotate recovery codes"}
                </Button>
                <Button size="sm" variant="outline" onClick={() => void disable()} disabled={busy !== null} className="gap-2 text-destructive">
                  <ShieldOff className="h-4 w-4" /> {busy === "disable" ? "Disabling…" : "Disable two-factor"}
                </Button>
              </div>
            </div>
          </div>
        ) : setup ? (
          <div className="space-y-4">
            <div className="space-y-2 rounded-md border border-border bg-muted/40 p-4">
              <p className="eyebrow">Scan in your authenticator</p>
              <p className="text-sm text-muted-foreground">
                Add this secret manually if you cannot scan a QR code:
              </p>
              <p className="num break-all rounded border border-border bg-background px-3 py-2 text-sm font-semibold tracking-[0.15em]">
                {setup.secret}
              </p>
              <p className="num break-all text-[11px] text-muted-foreground">{setup.otpauthUri}</p>
            </div>
            <div className="grid gap-4 sm:grid-cols-[minmax(0,200px)_auto] sm:items-end">
              <div className="space-y-1.5">
                <Label htmlFor="mfa-setup-code">6-digit code</Label>
                <Input
                  id="mfa-setup-code"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  maxLength={6}
                  value={code}
                  onChange={(event) => setCode(event.target.value)}
                  placeholder="123456"
                  className="num tracking-[0.25em]"
                />
              </div>
              <div className="flex flex-wrap gap-2">
                <Button size="sm" onClick={() => void confirm()} disabled={busy !== null} className="gap-2">
                  <ShieldCheck className="h-4 w-4" /> {busy === "confirm" ? "Verifying…" : "Confirm and enable"}
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setSetup(null)} disabled={busy !== null}>
                  Cancel
                </Button>
              </div>
            </div>
          </div>
        ) : (
          <div className="space-y-4">
            <p className="text-sm leading-relaxed text-muted-foreground">
              Two-factor adds a step-up code to every gated action — minting keys, editing
              allowances, deleting workspaces. Recovery codes work when your device does not.
            </p>
            <Button size="sm" onClick={() => void begin()} disabled={busy !== null} className="gap-2">
              <KeyRound className="h-4 w-4" /> {busy === "begin" ? "Preparing…" : "Set up two-factor authentication"}
            </Button>
          </div>
        )}

        {recoveryCodes ? (
          <div className="rounded-md border border-primary/40 bg-primary/8 p-4">
            <p className="eyebrow text-primary">Recovery codes — shown once</p>
            <ul className="num mt-2 grid gap-1 text-sm sm:grid-cols-2">
              {recoveryCodes.map((recoveryCode) => (
                <li key={recoveryCode} className="rounded bg-background/70 px-2 py-1">
                  {recoveryCode}
                </li>
              ))}
            </ul>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  navigator.clipboard?.writeText(recoveryCodes.join("\n")).catch(() => undefined);
                  toast.success("Recovery codes copied");
                }}
              >
                Copy all
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setRecoveryCodes(null)}>
                I have saved them
              </Button>
            </div>
          </div>
        ) : null}
      </div>
    </Panel>
  );
}
