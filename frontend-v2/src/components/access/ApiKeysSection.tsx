import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Skeleton } from "@/components/ui/skeleton";
import { Panel, StatusPill } from "@/components/portal/Panel";
import { EmptyState, ErrorState } from "@/components/portal/EmptyState";
import { ListToolbar } from "@/components/portal/ListToolbar";
import { ConfirmGate } from "@/components/portal/ConfirmGate";
import { OneTimeSecret } from "@/components/portal/OneTimeSecret";
import { ConfirmSecretDialog } from "@/components/portal/ConfirmSecretDialog";
import { ScopeCheckboxes, ScopeSummary } from "@/components/portal/ScopeCheckboxes";
import { MintKeyDialog } from "@/components/access/MintKeyDialog";
import { api, errorMessage, isConfirmSecretMissing } from "@/lib/api";
import { formatDate, formatRelative, shortId } from "@/lib/format";
import type { ApiKey, MeResponse } from "@/lib/types";
import type { QueryLike } from "@/lib/query-types";
import { ChevronDown, KeyRound, MoreVertical, Trash2 } from "lucide-react";
import { toast } from "@/utils/toast";

export function ApiKeysSection({
  workspaceId,
  workspaceName,
  query,
  me,
  code,
  codeLoading,
  codeError,
  refreshCode,
  reload,
}: {
  workspaceId: string;
  workspaceName: string;
  query: QueryLike<ApiKey[]>;
  me: MeResponse | null;
  code: string | null;
  codeLoading: boolean;
  codeError: string | null;
  refreshCode: () => void;
  reload: () => void;
}) {
  // The server returns the active workspace's keys plus account-wide keys; drop
  // anything from another workspace so the list never leaks across scopes.
  const keys = useMemo(
    () => (query.data ?? []).filter((key) => key.isAccountWide || key.workspaceId === workspaceId),
    [query.data, workspaceId],
  );
  const [filter, setFilter] = useState("");
  const [mode, setMode] = useState<"table" | "cards">("table");
  const [mintOpen, setMintOpen] = useState(false);
  const [rawSecret, setRawSecret] = useState<string | null>(null);
  const [needSecret, setNeedSecret] = useState(false);
  const [revokeTarget, setRevokeTarget] = useState<ApiKey | null>(null);
  const [revoking, setRevoking] = useState(false);

  const filtered = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    if (!needle) return keys;
    return keys.filter((key) =>
      [key.name, key.prefix, key.isAccountWide ? "account-wide" : (key.workspaceName ?? ""), ...key.scopes]
        .join(" ")
        .toLowerCase()
        .includes(needle),
    );
  }, [keys, filter]);

  async function confirmRevoke() {
    if (!revokeTarget) return;
    setRevoking(true);
    try {
      await api.del<{ success: boolean }>(`/api/keys/${revokeTarget.id}`);
      toast.success(`Revoked ${revokeTarget.name}`);
      setRevokeTarget(null);
      reload();
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setRevoking(false);
    }
  }

  const gate: Gate = { code, codeLoading, codeError, refreshCode, me };

  return (
    <Panel
      eyebrow="Credentials"
      title="API keys"
      action={
        <ListToolbar
          value={filter}
          onChange={setFilter}
          placeholder="Filter keys"
          mode={mode}
          onMode={setMode}
          right={
            <MintKeyDialog
              open={mintOpen}
              onOpenChange={setMintOpen}
              workspaceId={workspaceId}
              workspaceName={workspaceName}
              code={code}
              codeLoading={codeLoading}
              codeError={codeError}
              refreshCode={refreshCode}
              me={me}
              onMinted={setRawSecret}
              needSecretSetup={() => setNeedSecret(true)}
              reload={reload}
            />
          }
        />
      }
      bodyClassName="min-h-[220px]"
    >
      <div className="space-y-4 p-5">
        {rawSecret ? (
          <OneTimeSecret
            label="New API key secret"
            value={rawSecret}
            hint="Add it to your agent now — Octo stores only the prefix, and this display clears when dismissed."
            onDismiss={() => setRawSecret(null)}
          />
        ) : null}

        {query.isError ? (
          <ErrorState title="Could not load API keys" detail={errorMessage(query.error)} onRetry={() => query.refetch()} />
        ) : query.isPending ? (
          <div className="space-y-2">
            {[0, 1, 2].map((row) => (
              <Skeleton key={row} className="h-14 w-full" />
            ))}
          </div>
        ) : keys.length === 0 ? (
          <EmptyState
            motif="keys"
            title="No keys yet"
            description="Mint a key to let an agent read, write or archive objects in this workspace."
            action={
              <Button size="sm" onClick={() => setMintOpen(true)} className="gap-2">
                <KeyRound className="h-4 w-4" /> Mint a key
              </Button>
            }
          />
        ) : filtered.length === 0 ? (
          <EmptyState
            motif="keys"
            title="No keys match that filter"
            description={`None of the ${keys.length} loaded key${keys.length === 1 ? "" : "s"} matched “${filter}”.`}
            action={
              <Button size="sm" variant="outline" onClick={() => setFilter("")}>
                Clear filter
              </Button>
            }
          />
        ) : mode === "table" ? (
          <div className="overflow-x-auto rounded-md border border-border">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Prefix</th>
                  <th>Workspace</th>
                  <th>Allowances</th>
                  <th className="hidden md:table-cell">Created</th>
                  <th className="hidden lg:table-cell">Last used</th>
                  <th className="text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((key) => (
                  <tr key={key.id}>
                    <td className="max-w-[220px] truncate font-medium">{key.name}</td>
                    <td className="num whitespace-nowrap text-xs">{`<${key.prefix}…`}</td>
                    <td className="text-xs">
                      {key.isAccountWide ? (
                        <StatusPill tone="info">Account-wide</StatusPill>
                      ) : (
                        <span className="truncate">{key.workspaceName ?? workspaceName}</span>
                      )}
                    </td>
                    <td className="min-w-[190px]">
                      <AllowanceEditor apiKey={key} gate={gate} reload={reload} onNeedSecret={() => setNeedSecret(true)} />
                    </td>
                    <td className="hidden whitespace-nowrap text-xs text-muted-foreground md:table-cell">{formatDate(key.createdAt)}</td>
                    <td className="hidden whitespace-nowrap text-xs text-muted-foreground lg:table-cell">
                      {key.lastUsedAt ? formatRelative(key.lastUsedAt) : "never"}
                      {key.expiresAt ? ` · exp ${formatDate(key.expiresAt)}` : ""}
                    </td>
                    <td className="text-right">
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button size="icon" variant="ghost" className="h-8 w-8" aria-label={`Actions for ${key.name}`}>
                            <MoreVertical className="h-4 w-4" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end" className="w-48">
                          <DropdownMenuItem
                            className="gap-2 text-destructive focus:bg-destructive/10 focus:text-destructive"
                            onSelect={() => setRevokeTarget(key)}
                          >
                            <Trash2 className="h-4 w-4" /> Revoke key
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {filtered.map((key) => (
              <div key={key.id} className="panel space-y-3 p-4">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="truncate font-display text-sm font-semibold">{key.name}</p>
                    <p className="num truncate text-[11px] text-muted-foreground">{`<${key.prefix}…`}</p>
                  </div>
                  {key.isAccountWide ? (
                    <StatusPill tone="info">Account-wide</StatusPill>
                  ) : (
                    <StatusPill tone="muted">{key.workspaceName ?? workspaceName}</StatusPill>
                  )}
                </div>
                <p className="text-[11px] leading-relaxed text-muted-foreground">
                  created {formatDate(key.createdAt)} · {key.lastUsedAt ? `used ${formatRelative(key.lastUsedAt)}` : "never used"}
                  {key.expiresAt ? ` · expires ${formatDate(key.expiresAt)}` : " · no expiry"}
                </p>
                <AllowanceEditor apiKey={key} gate={gate} reload={reload} onNeedSecret={() => setNeedSecret(true)} />
                <Button size="sm" variant="outline" className="h-8 w-full gap-1.5 text-xs" onClick={() => setRevokeTarget(key)}>
                  <Trash2 className="h-3.5 w-3.5" /> Revoke key
                </Button>
              </div>
            ))}
          </div>
        )}
      </div>

      <AlertDialog open={Boolean(revokeTarget)} onOpenChange={(open) => !open && setRevokeTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Revoke {revokeTarget?.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              Any agent using this key stops working immediately. A revoked key cannot be restored.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep key</AlertDialogCancel>
            <AlertDialogAction onClick={() => void confirmRevoke()} disabled={revoking}>
              {revoking ? "Revoking…" : "Revoke key"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <ConfirmSecretDialog open={needSecret} onOpenChange={setNeedSecret} onDone={refreshCode} />
    </Panel>
  );
}

type Gate = {
  code: string | null;
  codeLoading: boolean;
  codeError: string | null;
  refreshCode: () => void;
  me: MeResponse | null;
};

/** Allowances live behind a collapsed control so the table stays readable; the
 *  trigger summarises the current set. */
function AllowanceEditor({
  apiKey,
  gate,
  reload,
  onNeedSecret,
}: {
  apiKey: ApiKey;
  gate: Gate;
  reload: () => void;
  onNeedSecret: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [scopes, setScopes] = useState<string[]>(apiKey.scopes);
  const [typed, setTyped] = useState("");
  const [mfaCode, setMfaCode] = useState("");
  const [busy, setBusy] = useState(false);

  const dirty = scopes.join("|") !== apiKey.scopes.join("|");

  async function save() {
    setBusy(true);
    try {
      await api.patch<ApiKey>(`/api/keys/${apiKey.id}`, {
        scopes,
        confirmSecret: typed,
        mfaCode: gate.me?.mfaEnabled ? mfaCode : undefined,
      });
      toast.success(`Allowances updated for ${apiKey.name}`);
      setOpen(false);
      setTyped("");
      setMfaCode("");
      reload();
    } catch (error) {
      if (isConfirmSecretMissing(error)) onNeedSecret();
      else toast.error(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Collapsible open={open} onOpenChange={setOpen} className="w-full">
      <CollapsibleTrigger asChild>
        <button
          type="button"
          className="flex w-full items-center justify-between gap-2 rounded-md border border-transparent px-1 py-0.5 text-left transition-colors hover:border-border hover:bg-secondary"
        >
          <ScopeSummary scopes={apiKey.scopes} />
          <span className="flex shrink-0 items-center gap-1 text-[11px] text-muted-foreground">
            edit
            <ChevronDown className={open ? "h-3.5 w-3.5 rotate-180 transition-transform" : "h-3.5 w-3.5 transition-transform"} />
          </span>
        </button>
      </CollapsibleTrigger>
      <CollapsibleContent className="pt-2">
        <div className="space-y-3 rounded-md border border-border bg-muted/40 p-3">
          <ScopeCheckboxes value={scopes} onChange={setScopes} idPrefix={`key-${shortId(apiKey.id, 6)}`} />
          <ConfirmGate
            code={gate.code}
            loading={gate.codeLoading}
            error={gate.codeError}
            onRefresh={gate.refreshCode}
            value={typed}
            onChange={setTyped}
            mfaEnabled={Boolean(gate.me?.mfaEnabled)}
            mfaValue={mfaCode}
            onMfaChange={setMfaCode}
          />
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="ghost" className="h-8 text-xs" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button size="sm" className="h-8 text-xs" onClick={() => void save()} disabled={!dirty || busy}>
              {busy ? "Saving…" : "Save allowances"}
            </Button>
          </div>
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
