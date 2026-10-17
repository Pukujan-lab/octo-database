import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { KeyRound, ShieldAlert } from "lucide-react";
import { Panel, StatusPill, type PillTone } from "@/components/portal/Panel";
import { ConfirmGate } from "@/components/portal/ConfirmGate";
import { CopyButton, EmptyState } from "@/components/portal/EmptyState";
import { OneTimeSecret } from "@/components/portal/OneTimeSecret";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { useConfirmChallenge } from "@/hooks/useConfirmChallenge";
import { api, errorMessage, isConfirmSecretMissing } from "@/lib/api";
import type { MeResponse, Workspace } from "@/lib/types";
import { toast } from "@/utils/toast";

type Kind = "login" | "token" | "url" | "note";
type Health = "unchecked" | "healthy" | "weak" | "stale";
type AuthScheme = "bearer" | "x-api-key" | "basic" | "query" | "body_json" | "path";
type RouteHealth = "unknown" | "ok" | "unauthorized" | "forbidden_group" | "unreachable";
type UrlKind = "api_base" | "api_endpoint" | "docs" | "console" | "cors" | "s3_endpoint";

interface VaultItem {
  id: string;
  workspaceId: string | null;
  label: string;
  description: string;
  kind: Kind;
  username: string | null;
  url: string | null;
  urlKind: UrlKind | null;
  hasSecret: boolean;
  hasNotes: boolean;
  healthStatus: Health;
  healthDetail: string | null;
  staleSince: string | null;
}

interface VaultRoute {
  id: string;
  itemId: string;
  routeKey: string;
  name: string;
  baseUrl: string;
  authScheme: AuthScheme;
  authHeader: string | null;
  bodyField: string | null;
  basicUsername: string | null;
  healthStatus: RouteHealth;
  healthDetail: string | null;
  lastHealthAt: string | null;
  createdAt: string;
}

interface VaultLease {
  id: string;
  itemId: string;
  itemLabel: string;
  parentGrantId: string;
  prefix: string;
  name: string;
  expiresAt: string;
  revokedAt: string | null;
  createdAt: string;
  lastUsedAt: string | null;
}

interface VaultGrant {
  id: string;
  workspaceId: string | null;
  prefix: string;
  name: string;
  decoy: boolean;
  expiresAt: string;
  trippedAt: string | null;
}

const HOURS = [5, 10, 24, 48, 72] as const;

const HEALTH_TONE: Record<Health, PillTone> = {
  healthy: "success",
  weak: "warning",
  stale: "danger",
  unchecked: "muted",
};

const ROUTE_TONE: Record<RouteHealth, PillTone> = {
  ok: "success",
  unauthorized: "danger",
  forbidden_group: "warning",
  unreachable: "danger",
  unknown: "muted",
};

const SCHEMES: Array<{ value: AuthScheme; label: string }> = [
  { value: "bearer", label: "Bearer token" },
  { value: "x-api-key", label: "x-api-key header" },
  { value: "basic", label: "Basic auth" },
  { value: "query", label: "Query parameter" },
  { value: "body_json", label: "JSON body field" },
  { value: "path", label: "Path segment" },
];

const URL_KINDS: Array<{ value: UrlKind; label: string }> = [
  { value: "api_base", label: "API base" },
  { value: "api_endpoint", label: "API endpoint" },
  { value: "docs", label: "Docs" },
  { value: "console", label: "Console" },
  { value: "cors", label: "CORS proxy" },
  { value: "s3_endpoint", label: "S3 endpoint" },
];

function relayUrl(routeKey: string): string {
  return `${window.location.origin}/api/vault/relay/${routeKey}`;
}

export function VaultView({
  workspace,
  me,
}: {
  workspace: Workspace | null;
  me: MeResponse | null;
}) {
  const challenge = useConfirmChallenge(true);
  const [typed, setTyped] = useState("");
  const [mfaCode, setMfaCode] = useState("");
  const [codeUsed, setCodeUsed] = useState(false);
  const [rawSecret, setRawSecret] = useState<string | null>(null);
  const [revealed, setRevealed] = useState<{ label: string; secret: string | null; notes: string | null } | null>(null);

  const itemsQuery = useQuery({
    queryKey: ["vault-items"],
    queryFn: () => api.get<{ items: VaultItem[] }>("/api/vault/items"),
  });
  const grantsQuery = useQuery({
    queryKey: ["vault-grants"],
    queryFn: () => api.get<{ grants: VaultGrant[] }>("/api/vault/grants"),
  });
  const leasesQuery = useQuery({
    queryKey: ["vault-leases"],
    queryFn: () => api.get<{ leases: VaultLease[] }>("/api/vault/leases"),
  });

  const items = itemsQuery.data?.items ?? [];
  const grants = grantsQuery.data?.grants ?? [];
  const leases = leasesQuery.data?.leases ?? [];
  const accountItems = items.filter((item) => item.workspaceId === null);
  const workspaceItems = workspace ? items.filter((item) => item.workspaceId === workspace.id) : [];

  function gateBody() {
    return {
      confirmSecret: typed,
      mfaCode: me?.mfaEnabled ? mfaCode : undefined,
    };
  }

  function afterGate() {
    setTyped("");
    setMfaCode("");
    setCodeUsed(true);
    void challenge.refresh().finally(() => setCodeUsed(false));
  }

  function onGateError(error: unknown) {
    if (isConfirmSecretMissing(error)) {
      toast.error("Set a confirmation secret on the Access page first.");
      return;
    }
    toast.error(errorMessage(error));
  }

  async function reload() {
    await Promise.all([itemsQuery.refetch(), grantsQuery.refetch(), leasesQuery.refetch()]);
  }

  return (
    <div data-testid="view-vault" className="animate-fade-rise space-y-6">
      <Panel eyebrow="Cabinet" title="Keys">
        <p className="p-5 text-sm leading-relaxed text-muted-foreground">
          Drop a login, token, URL, or note here. Account keys stay with you. Workspace keys stay on the workspace you assign.
          At an event, mint a temporary grant and hand that to an agent. The grant reads one cabinet. The agent can ask for a decoy grant that answers the same way and never returns the stored secret.
        </p>
      </Panel>

      <Panel eyebrow="Gate" title="Confirm each change">
        <div className="space-y-3 p-5">
          <p className="text-sm leading-relaxed text-muted-foreground">
            Every save, import, mint, remove and revoke on this page uses the code below. It is
            single-use, so a fresh one is issued as soon as you use it.
          </p>
          <ConfirmGate
            code={challenge.code}
            expiresAt={challenge.expiresAt}
            used={codeUsed}
            loading={challenge.loading}
            error={challenge.error}
            onRefresh={challenge.refresh}
            value={typed}
            onChange={setTyped}
            mfaEnabled={Boolean(me?.mfaEnabled)}
            mfaValue={mfaCode}
            onMfaChange={setMfaCode}
          />
        </div>
      </Panel>

      {rawSecret ? (
        <OneTimeSecret
          label="Vault grant"
          value={rawSecret}
          hint="Paste this into the agent. It expires on its own. Octo keeps only a hash."
          onDismiss={() => setRawSecret(null)}
        />
      ) : null}

      {revealed ? (
        <OneTimeSecret
          label={revealed.label}
          value={revealed.secret || revealed.notes || ""}
          hint={revealed.notes && revealed.secret ? `Notes: ${revealed.notes}` : "Shown from this session only. Dismiss to clear it."}
          onDismiss={() => setRevealed(null)}
        />
      ) : null}

      <MintGrant
        workspace={workspace}
        onMinted={(secret) => {
          setRawSecret(secret);
          afterGate();
          void reload();
        }}
        gate={gateBody}
        onError={onGateError}
      />

      <div className="grid gap-6 xl:grid-cols-2">
        <Cabinet
          idPrefix="vault-account"
          title="Account"
          eyebrow="Every workspace"
          items={accountItems}
          loading={itemsQuery.isPending}
          error={itemsQuery.isError ? errorMessage(itemsQuery.error) : null}
          onRetry={() => void itemsQuery.refetch()}
          workspaceId={null}
          gate={gateBody}
          onSaved={() => {
            afterGate();
            void reload();
          }}
          onError={onGateError}
          onReveal={setRevealed}
        />
        <Cabinet
          idPrefix="vault-workspace"
          title={workspace ? workspace.name : "Workspace"}
          eyebrow="This workspace only"
          items={workspaceItems}
          loading={itemsQuery.isPending}
          error={itemsQuery.isError ? errorMessage(itemsQuery.error) : null}
          onRetry={() => void itemsQuery.refetch()}
          workspaceId={workspace?.id ?? null}
          disabled={!workspace}
          gate={gateBody}
          onSaved={() => {
            afterGate();
            void reload();
          }}
          onError={onGateError}
          onReveal={setRevealed}
        />
      </div>

      <Panel
        eyebrow="Grants"
        title="Temporary keys"
        action={
          <Button
            size="sm"
            variant="outline"
            className="gap-1.5"
            onClick={async () => {
              try {
                const result = await api.post<{ purged: number }>("/api/vault/health", gateBody());
                toast.success(result.purged ? `Checked keys. Removed ${result.purged} stale.` : "Checked keys.");
                afterGate();
                void reload();
              } catch (error) {
                onGateError(error);
              }
            }}
          >
            <ShieldAlert className="h-4 w-4" /> Check health
          </Button>
        }
      >
        <div className="p-5">
          {grants.length === 0 ? (
            <EmptyState motif="keys" title="No grants yet" description="Mint one when you are about to hand a cabinet to an agent." />
          ) : (
            <ul className="space-y-2">
              {grants.map((grant) => (
                <li key={grant.id} className="flex flex-wrap items-center gap-2 rounded-md border border-border px-3 py-2">
                  <KeyRound className="h-4 w-4 text-muted-foreground" />
                  <span className="font-medium">{grant.name}</span>
                  <span className="num text-xs text-muted-foreground">{grant.prefix}</span>
                  <StatusPill tone={grant.workspaceId ? "info" : "primary"}>{grant.workspaceId ? "workspace" : "account"}</StatusPill>
                  {grant.decoy ? <StatusPill tone="warning">decoy</StatusPill> : <StatusPill tone="success">real</StatusPill>}
                  {grant.trippedAt ? <StatusPill tone="danger">tripped</StatusPill> : null}
                  <span className="text-xs text-muted-foreground">until {new Date(grant.expiresAt).toLocaleString()}</span>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="ml-auto h-7 text-xs"
                    onClick={async () => {
                      try {
                        await api.del(`/api/vault/grants/${grant.id}`, gateBody());
                        toast.success("Grant revoked");
                        afterGate();
                        void reload();
                      } catch (error) {
                        onGateError(error);
                      }
                    }}
                  >
                    Revoke
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </Panel>

      <WorkingKeys
        leases={leases}
        loading={leasesQuery.isPending}
        gate={gateBody}
        onError={onGateError}
        onRevoked={() => {
          afterGate();
          void reload();
        }}
      />
    </div>
  );
}

function WorkingKeys({
  leases,
  loading,
  gate,
  onError,
  onRevoked,
}: {
  leases: VaultLease[];
  loading: boolean;
  gate: () => { confirmSecret: string; mfaCode?: string };
  onError: (error: unknown) => void;
  onRevoked: () => void;
}) {
  const queryClient = useQueryClient();

  async function revoke(lease: VaultLease) {
    try {
      await api.del(`/api/vault/leases/${lease.id}`, gate());
      toast.success("Working key revoked");
      await queryClient.invalidateQueries({ queryKey: ["vault-leases"] });
      onRevoked();
    } catch (error) {
      onError(error);
    }
  }

  return (
    <Panel eyebrow="Relay" title="Working keys">
      <div className="p-5">
        {loading ? (
          <div className="h-16 animate-pulse rounded-md bg-muted" />
        ) : leases.length === 0 ? (
          <EmptyState
            motif="keys"
            title="No working keys yet"
            description="An agent holding a grant names a stored key and Octo mints one for it. The key expires on its own and can be revoked here."
          />
        ) : (
          <ul className="space-y-2" data-testid="vault-leases">
            {leases.map((lease) => {
              const expired = lease.revokedAt !== null || Date.parse(lease.expiresAt) <= Date.now();
              return (
                <li key={lease.id} className="flex flex-wrap items-center gap-2 rounded-md border border-border px-3 py-2">
                  <KeyRound className="h-4 w-4 text-muted-foreground" />
                  <span className="font-medium">{lease.itemLabel}</span>
                  <span className="text-xs text-muted-foreground">{lease.name}</span>
                  <span className="num text-xs text-muted-foreground">{lease.prefix}</span>
                  {expired ? (
                    <StatusPill tone="danger">{lease.revokedAt ? "revoked" : "expired"}</StatusPill>
                  ) : (
                    <StatusPill tone="success">live</StatusPill>
                  )}
                  <span className="text-xs text-muted-foreground">until {new Date(lease.expiresAt).toLocaleString()}</span>
                  <span className="text-xs text-muted-foreground">
                    {lease.lastUsedAt ? `used ${new Date(lease.lastUsedAt).toLocaleString()}` : "never used"}
                  </span>
                  {expired ? null : (
                    <Button
                      size="sm"
                      variant="ghost"
                      className="ml-auto h-7 text-xs"
                      onClick={() => void revoke(lease)}
                    >
                      Revoke
                    </Button>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </Panel>
  );
}

function MintGrant({
  workspace,
  onMinted,
  gate,
  onError,
}: {
  workspace: Workspace | null;
  onMinted: (secret: string) => void;
  gate: () => { confirmSecret: string; mfaCode?: string };
  onError: (error: unknown) => void;
}) {
  const [name, setName] = useState("");
  const [hours, setHours] = useState("24");
  const [scope, setScope] = useState<"account" | "workspace">("account");
  const [busy, setBusy] = useState(false);

  async function submit() {
    if (!name.trim()) {
      toast.error("Name the grant");
      return;
    }
    setBusy(true);
    try {
      const result = await api.post<{ rawSecret: string }>("/api/vault/grants", {
        name: name.trim(),
        expiresInHours: Number(hours),
        workspaceId: scope === "workspace" ? workspace?.id : null,
        ...gate(),
      });
      onMinted(result.rawSecret);
      setName("");
      toast.success("Grant minted");
    } catch (error) {
      onError(error);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Panel eyebrow="Hand-off" title="Mint a temporary grant">
      <div className="grid gap-4 p-5 sm:grid-cols-2 lg:grid-cols-4">
        <div className="space-y-1.5 sm:col-span-2">
          <Label htmlFor="vault-grant-name">Name</Label>
          <Input id="vault-grant-name" value={name} onChange={(event) => setName(event.target.value)} placeholder="hackathon friday" />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="vault-grant-scope">Cabinet</Label>
          <Select value={scope} onValueChange={(value) => setScope(value as "account" | "workspace")}>
            <SelectTrigger id="vault-grant-scope">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="account">Account</SelectItem>
              <SelectItem value="workspace" disabled={!workspace}>
                This workspace
              </SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="vault-grant-hours">Hours</Label>
          <Input
            id="vault-grant-hours"
            inputMode="numeric"
            value={hours}
            onChange={(event) => setHours(event.target.value)}
          />
        </div>
        <div className="flex flex-wrap items-center gap-2 sm:col-span-2 lg:col-span-4">
          {HOURS.map((choice) => (
            <Button key={choice} type="button" size="sm" variant={hours === String(choice) ? "default" : "outline"} onClick={() => setHours(String(choice))}>
              {choice}h
            </Button>
          ))}
          <Button type="button" className="ml-auto" disabled={busy} onClick={() => void submit()}>
            Mint grant
          </Button>
        </div>
        <p className="text-xs text-muted-foreground sm:col-span-2 lg:col-span-4">
          Default is 24 hours. Any whole number from 5 through 72 works, including 5 and 10. Three days is 72.
        </p>
      </div>
    </Panel>
  );
}

function Cabinet({
  idPrefix,
  title,
  eyebrow,
  items,
  loading,
  error,
  onRetry,
  workspaceId,
  disabled,
  gate,
  onSaved,
  onError,
  onReveal,
}: {
  idPrefix: string;
  title: string;
  eyebrow: string;
  items: VaultItem[];
  loading: boolean;
  error: string | null;
  onRetry: () => void;
  workspaceId: string | null;
  disabled?: boolean;
  gate: () => { confirmSecret: string; mfaCode?: string };
  onSaved: () => void;
  onError: (error: unknown) => void;
  onReveal: (value: { label: string; secret: string | null; notes: string | null }) => void;
}) {
  const [label, setLabel] = useState("");
  const [description, setDescription] = useState("");
  const [kind, setKind] = useState<Kind>("token");
  const [urlKind, setUrlKind] = useState<UrlKind>("api_base");
  const [openRoutes, setOpenRoutes] = useState<string | null>(null);
  const [username, setUsername] = useState("");
  const [url, setUrl] = useState("");
  const [secret, setSecret] = useState("");
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [filter, setFilter] = useState("");
  const [bulkOpen, setBulkOpen] = useState(false);
  const [bulkText, setBulkText] = useState("");
  const [bulkBusy, setBulkBusy] = useState(false);

  const filtered = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    if (!needle) return items;
    return items.filter((item) =>
      `${item.label} ${item.description}`.toLowerCase().includes(needle),
    );
  }, [items, filter]);

  const bulkLines = bulkText.split("\n").map((line) => line.trim()).filter(Boolean);

  async function importMany() {
    if (bulkLines.length === 0) {
      toast.error("Paste at least one LABEL=secret line");
      return;
    }
    setBulkBusy(true);
    try {
      const result = await api.post<{ inserted: number }>("/api/vault/items/bulk", {
        lines: bulkLines,
        kind,
        workspaceId,
        ...gate(),
      });
      setBulkText("");
      toast.success(`Imported ${result.inserted} key${result.inserted === 1 ? "" : "s"}`);
      onSaved();
    } catch (caught) {
      onError(caught);
    } finally {
      setBulkBusy(false);
    }
  }

  async function save() {
    setBusy(true);
    try {
      await api.post("/api/vault/items", {
        label,
        description,
        kind,
        username,
        url,
        urlKind: kind === "url" ? urlKind : null,
        secret,
        notes,
        workspaceId,
        ...gate(),
      });
      setLabel("");
      setDescription("");
      setUsername("");
      setUrl("");
      setSecret("");
      setNotes("");
      toast.success("Saved in the cabinet");
      onSaved();
    } catch (caught) {
      onError(caught);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Panel eyebrow={eyebrow} title={title}>
      <div className="space-y-4 p-5">
        {disabled ? (
          <p className="text-sm text-muted-foreground">Create a workspace before assigning keys to one.</p>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label>Label</Label>
              <Input value={label} onChange={(event) => setLabel(event.target.value)} placeholder="Cloudflare" />
            </div>
            <div className="space-y-1.5">
              <Label>Kind</Label>
              <Select
                value={kind}
                onValueChange={(value) => {
                  setKind(value as Kind);
                  if (value !== "url") setUrlKind("api_base");
                }}
              >
                <SelectTrigger id={`${idPrefix}-kind`}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="login">Login</SelectItem>
                  <SelectItem value="token">Token</SelectItem>
                  <SelectItem value="url">URL</SelectItem>
                  <SelectItem value="note">Note</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>Username</Label>
              <Input value={username} onChange={(event) => setUsername(event.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label>URL</Label>
              <Input value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://" />
            </div>
            {kind === "url" ? (
              <div className="space-y-1.5">
                <Label>URL kind</Label>
                <Select value={urlKind} onValueChange={(value) => setUrlKind(value as UrlKind)}>
                  <SelectTrigger id={`${idPrefix}-urlkind`}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {URL_KINDS.map((choice) => (
                      <SelectItem key={choice.value} value={choice.value}>
                        {choice.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            ) : null}
            <div className="space-y-1.5 sm:col-span-2">
              <Label htmlFor={`${idPrefix}-description`}>Description</Label>
              <Input
                id={`${idPrefix}-description`}
                value={description}
                onChange={(event) => setDescription(event.target.value)}
                placeholder={
                  kind === "login"
                    ? "What this password is for, so an agent picks the right one"
                    : "What this key is for, so an agent does not mix it up"
                }
              />
            </div>
            <div className="space-y-1.5 sm:col-span-2">
              <Label htmlFor={`${idPrefix}-secret`}>{kind === "login" ? "Password" : kind === "token" ? "Token" : "Secret"}</Label>
              <Input
                id={`${idPrefix}-secret`}
                value={secret}
                onChange={(event) => setSecret(event.target.value)}
                type="password"
                autoComplete="off"
              />
            </div>
            <div className="space-y-1.5 sm:col-span-2">
              <Label>Notes</Label>
              <Input value={notes} onChange={(event) => setNotes(event.target.value)} />
            </div>
            <Button type="button" disabled={busy} onClick={() => void save()}>
              Save key
            </Button>
          </div>
        )}

        {!disabled ? (
          <div className="rounded-md border border-border">
            <button
              type="button"
              data-testid={`${idPrefix}-bulk-toggle`}
              onClick={() => setBulkOpen((open) => !open)}
              className="flex w-full items-center justify-between px-3 py-2 text-left text-xs font-medium text-muted-foreground hover:text-foreground"
            >
              <span>Paste many — one key per line</span>
              <span>{bulkOpen ? "hide" : "open"}</span>
            </button>
            {bulkOpen ? (
              <div className="space-y-2 border-t border-border p-3">
                <Textarea
                  data-testid={`${idPrefix}-bulk`}
                  value={bulkText}
                  onChange={(event) => setBulkText(event.target.value)}
                  rows={5}
                  spellCheck={false}
                  placeholder={"Cloudflare=cf-token\nGitHub=ghp_xxxx"}
                  className="num bg-background text-xs"
                />
                <div className="flex flex-wrap items-center gap-2">
                  <p className="text-[11px] text-muted-foreground">
                    LABEL=secret per line, saved as {kind}. The description is set to the label.
                  </p>
                  <Button
                    type="button"
                    size="sm"
                    className="ml-auto h-8 text-xs"
                    data-testid={`${idPrefix}-bulk-import`}
                    disabled={bulkBusy || bulkLines.length === 0}
                    onClick={() => void importMany()}
                  >
                    {bulkBusy
                      ? "Importing…"
                      : bulkLines.length === 0
                        ? "Import keys"
                        : `Import ${bulkLines.length} key${bulkLines.length === 1 ? "" : "s"}`}
                  </Button>
                </div>
              </div>
            ) : null}
          </div>
        ) : null}

        {error ? (
          <EmptyState title="Could not load keys" description={error} action={<Button onClick={onRetry}>Retry</Button>} />
        ) : loading ? (
          <div className="h-16 animate-pulse rounded-md bg-muted" />
        ) : items.length === 0 ? (
          <p className="text-sm text-muted-foreground">Nothing stored here yet.</p>
        ) : (
          <div className="space-y-2">
            <Input
              data-testid={`${idPrefix}-filter`}
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
              placeholder={`Filter ${items.length} key${items.length === 1 ? "" : "s"}`}
              className="h-8 bg-background text-sm"
              aria-label="Filter keys"
            />
            {filtered.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No keys match “{filter}”.{" "}
                <button type="button" className="underline underline-offset-2" onClick={() => setFilter("")}>
                  Clear
                </button>
              </p>
            ) : (
              <ul className="space-y-1" data-testid={`${idPrefix}-items`}>
                {filtered.map((item) => (
                  <li key={item.id} className="rounded-md border border-border">
                    <div className="flex flex-wrap items-center gap-2 px-3 py-1.5">
                      <span className="min-w-0 flex-1 truncate text-sm">
                        <span className="font-medium">{item.label}</span>
                        {item.description && item.description !== item.label ? (
                          <span className="ml-2 text-xs text-muted-foreground">{item.description}</span>
                        ) : null}
                      </span>
                      <StatusPill tone="muted">{item.kind}</StatusPill>
                      <span title={item.healthDetail ?? undefined}>
                        <StatusPill tone={HEALTH_TONE[item.healthStatus]}>{item.healthStatus}</StatusPill>
                      </span>
                      {item.kind === "token" || item.kind === "login" ? (
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-7 text-xs"
                          data-testid={`vault-routes-${item.id}-toggle`}
                          onClick={() => setOpenRoutes((current) => (current === item.id ? null : item.id))}
                        >
                          {openRoutes === item.id ? "Hide routes" : "Routes"}
                        </Button>
                      ) : null}
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-7 text-xs"
                        onClick={async () => {
                          try {
                            const result = await api.get<{ item: { label: string; secret: string | null; notes: string | null } }>(
                              `/api/vault/items/${item.id}`,
                            );
                            onReveal({ label: result.item.label, secret: result.item.secret, notes: result.item.notes });
                          } catch (caught) {
                            onError(caught);
                          }
                        }}
                      >
                        Show
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-7 text-xs"
                        onClick={async () => {
                          try {
                            await api.del(`/api/vault/items/${item.id}`, gate());
                            toast.success("Removed");
                            onSaved();
                          } catch (caught) {
                            onError(caught);
                          }
                        }}
                      >
                        Remove
                      </Button>
                    </div>
                    {openRoutes === item.id ? (
                      <ItemRoutes item={item} gate={gate} onError={onError} onChanged={onSaved} />
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>
    </Panel>
  );
}

function ItemRoutes({
  item,
  gate,
  onError,
  onChanged,
}: {
  item: VaultItem;
  gate: () => { confirmSecret: string; mfaCode?: string };
  onError: (error: unknown) => void;
  onChanged: () => void;
}) {
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [authScheme, setAuthScheme] = useState<AuthScheme>("bearer");
  const [authHeader, setAuthHeader] = useState("");
  const [bodyField, setBodyField] = useState("");
  const [basicUsername, setBasicUsername] = useState("");
  const [routeKey, setRouteKey] = useState("");
  const [busy, setBusy] = useState(false);

  const routesQuery = useQuery({
    queryKey: ["vault-routes", item.id],
    queryFn: () => api.get<{ routes: VaultRoute[] }>(`/api/vault/items/${item.id}/routes`),
  });
  const routes = routesQuery.data?.routes ?? [];

  async function add() {
    if (!name.trim() || !baseUrl.trim()) {
      toast.error("Name the route and give it a base URL");
      return;
    }
    setBusy(true);
    try {
      await api.post(`/api/vault/items/${item.id}/routes`, {
        name: name.trim(),
        baseUrl: baseUrl.trim(),
        authScheme,
        authHeader: authHeader.trim() || undefined,
        bodyField: bodyField.trim() || undefined,
        basicUsername: basicUsername.trim() || undefined,
        routeKey: routeKey.trim() || undefined,
        ...gate(),
      });
      setName("");
      setBaseUrl("");
      setAuthHeader("");
      setBodyField("");
      setBasicUsername("");
      setRouteKey("");
      toast.success("Route added");
      await queryClient.invalidateQueries({ queryKey: ["vault-routes", item.id] });
      onChanged();
    } catch (error) {
      onError(error);
    } finally {
      setBusy(false);
    }
  }

  async function remove(route: VaultRoute) {
    try {
      await api.del(`/api/vault/items/${item.id}/routes/${route.id}`, gate());
      toast.success("Route removed");
      await queryClient.invalidateQueries({ queryKey: ["vault-routes", item.id] });
      onChanged();
    } catch (error) {
      onError(error);
    }
  }

  return (
    <div className="space-y-2 border-t border-border p-3" data-testid={`vault-routes-${item.id}`}>
      {routesQuery.isPending ? (
        <div className="h-10 animate-pulse rounded-md bg-muted" />
      ) : routes.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          No routes yet. Add the vendor base URL an agent should call.
        </p>
      ) : (
        <ul className="space-y-1.5">
          {routes.map((route) => (
            <li key={route.id} className="flex flex-wrap items-center gap-2 rounded-md border border-border px-2 py-1.5">
              <span className="text-xs font-medium">{route.name}</span>
              <span className="num text-[11px] text-muted-foreground">{route.routeKey}</span>
              <StatusPill tone="muted">{route.authScheme}</StatusPill>
              <span title={route.healthDetail ?? undefined}>
                <StatusPill tone={ROUTE_TONE[route.healthStatus]}>{route.healthStatus}</StatusPill>
              </span>
              <span className="num truncate text-[11px] text-muted-foreground">{route.baseUrl}</span>
              <span className="ml-auto flex items-center gap-1">
                <span className="num hidden text-[11px] text-muted-foreground sm:inline">
                  {relayUrl(route.routeKey)}
                </span>
                <CopyButton value={relayUrl(route.routeKey)} onCopied={() => toast.success("Relay URL copied")} />
                <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => void remove(route)}>
                  Remove
                </Button>
              </span>
            </li>
          ))}
        </ul>
      )}

      <div className="grid gap-2 sm:grid-cols-2">
        <Input
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="Route name, e.g. Fish Audio API"
          aria-label="Route name"
        />
        <Input
          value={baseUrl}
          onChange={(event) => setBaseUrl(event.target.value)}
          placeholder="Base URL, e.g. https://api.fish.audio"
          aria-label="Base URL"
        />
        <Select value={authScheme} onValueChange={(value) => setAuthScheme(value as AuthScheme)}>
          <SelectTrigger aria-label="Auth scheme">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {SCHEMES.map((scheme) => (
              <SelectItem key={scheme.value} value={scheme.value}>
                {scheme.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {authScheme === "x-api-key" || authScheme === "query" ? (
          <Input
            value={authHeader}
            onChange={(event) => setAuthHeader(event.target.value)}
            placeholder={authScheme === "query" ? "Query parameter, e.g. api_key" : "Header, e.g. x-api-key"}
            aria-label="Auth header or query parameter"
          />
        ) : null}
        {authScheme === "body_json" || authScheme === "path" ? (
          <Input
            value={bodyField}
            onChange={(event) => setBodyField(event.target.value)}
            placeholder={authScheme === "path" ? "Path template, e.g. bot{key}/getMe" : "Body field, e.g. api_key"}
            aria-label="Body field or path template"
          />
        ) : null}
        {authScheme === "basic" ? (
          <Input
            value={basicUsername}
            onChange={(event) => setBasicUsername(event.target.value)}
            placeholder="Basic username (optional)"
            aria-label="Basic username"
          />
        ) : null}
        <Input
          value={routeKey}
          onChange={(event) => setRouteKey(event.target.value)}
          placeholder="Route key (optional, auto-generated)"
          aria-label="Route key"
        />
        <Button type="button" disabled={busy} onClick={() => void add()}>
          Add route
        </Button>
      </div>
      <p className="text-[11px] text-muted-foreground">
        An agent attaches its working key where the vendor expects it and points its client at the relay URL.
      </p>
    </div>
  );
}
