import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ConfirmGate } from "@/components/portal/ConfirmGate";
import { ScopeCheckboxes } from "@/components/portal/ScopeCheckboxes";
import { api, errorCode, errorMessage, isConfirmSecretMissing } from "@/lib/api";
import type { ApiKey, MeResponse } from "@/lib/types";
import { Plus } from "lucide-react";
import { toast } from "@/utils/toast";

export function MintKeyDialog({
  open,
  onOpenChange,
  workspaceId,
  workspaceName,
  me,
  code,
  codeLoading,
  codeError,
  refreshCode,
  onMinted,
  needSecretSetup,
  reload,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workspaceId: string;
  workspaceName: string;
  me: MeResponse | null;
  code: string | null;
  codeLoading: boolean;
  codeError: string | null;
  refreshCode: () => void;
  onMinted: (secret: string) => void;
  needSecretSetup: () => void;
  reload: () => void;
}) {
  const [name, setName] = useState("");
  const [scopeChoice, setScopeChoice] = useState<"workspace" | "account">("workspace");
  const [expiresInDays, setExpiresInDays] = useState<"never" | "30" | "90" | "365">("never");
  const [scopes, setScopes] = useState<string[]>(["read"]);
  const [typed, setTyped] = useState("");
  const [mfaCode, setMfaCode] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit() {
    if (!name.trim()) {
      toast.error("Name the key");
      return;
    }
    if (!scopes.length) {
      toast.error("Grant at least one allowance");
      return;
    }
    setBusy(true);
    try {
      const result = await api.post<{ apiKey: ApiKey; rawSecret: string }>("/api/keys", {
        name: name.trim(),
        workspaceId: scopeChoice === "account" ? null : workspaceId,
        scopes,
        expiresInDays: expiresInDays === "never" ? undefined : Number(expiresInDays),
        confirmSecret: typed,
        mfaCode: me?.mfaEnabled ? mfaCode : undefined,
      });
      // The raw secret lives only in this dialog's parent state until dismissed.
      onMinted(result.rawSecret);
      toast.success(`${result.apiKey.name} minted`);
      setName("");
      setTyped("");
      setMfaCode("");
      onOpenChange(false);
      reload();
    } catch (error) {
      if (isConfirmSecretMissing(error)) {
        needSecretSetup();
      } else if (errorCode(error) === "ACCOUNT_KEY_EXISTS") {
        toast.error("An account-wide key already exists for this account");
      } else {
        toast.error(errorMessage(error));
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger asChild>
        <Button size="sm" className="h-8 gap-1.5 text-xs">
          <Plus className="h-4 w-4" /> Mint a key
        </Button>
      </DialogTrigger>
      <DialogContent data-testid="key-mint-form" className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Mint an API key</DialogTitle>
          <DialogDescription>
            Scope it to {workspaceName} or to the whole account. The secret is displayed once.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="key-name">Name</Label>
              <Input id="key-name" value={name} onChange={(event) => setName(event.target.value)} placeholder="ingest-agent" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="key-scope">Scope</Label>
              <Select value={scopeChoice} onValueChange={(value) => setScopeChoice(value as "workspace" | "account")}>
                <SelectTrigger id="key-scope">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="workspace">This workspace</SelectItem>
                  <SelectItem value="account">Account-wide</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="key-expiry">Expiry</Label>
              <Select value={expiresInDays} onValueChange={(value) => setExpiresInDays(value as typeof expiresInDays)}>
                <SelectTrigger id="key-expiry">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="never">Never</SelectItem>
                  <SelectItem value="30">30 days</SelectItem>
                  <SelectItem value="90">90 days</SelectItem>
                  <SelectItem value="365">365 days</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2 pt-1">
              <Label className="text-xs">Allowances</Label>
              <ScopeCheckboxes value={scopes} onChange={setScopes} idPrefix="mint" />
            </div>
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
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={() => void submit()} disabled={busy}>
            {busy ? "Minting…" : "Mint key"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
