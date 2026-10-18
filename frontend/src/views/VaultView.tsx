import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowDown,
  ArrowUp,
  ChevronRight,
  ChevronsUpDown,
  Eye,
  KeyRound,
  Link2,
  MoreHorizontal,
  Pencil,
  Plus,
  Search,
  ShieldAlert,
  ShieldCheck,
  Trash2,
  X,
} from "lucide-react";
import { Panel, StatusPill, type PillTone } from "@/components/portal/Panel";
import { ConfirmGate } from "@/components/portal/ConfirmGate";
import { CopyButton, EmptyState } from "@/components/portal/EmptyState";
import { OneTimeSecret } from "@/components/portal/OneTimeSecret";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { useConfirmChallenge } from "@/hooks/useConfirmChallenge";
import { api, errorCode, errorMessage } from "@/lib/api";
import { cn } from "@/lib/utils";
import type { MeResponse, Workspace } from "@/lib/types";
import { toast } from "@/utils/toast";

type Kind = "login" | "token" | "url" | "note";
type Health = "unchecked" | "healthy" | "weak" | "stale";
type AuthScheme = "bearer" | "x-api-key" | "basic" | "query" | "body_json" | "path";
type RouteHealth = "unknown" | "ok" | "unauthorized" | "forbidden_group" | "unreachable";
type UrlKind = "api_base" | "api_endpoint" | "docs" | "console" | "cors" | "s3_endpoint";

/** What every write on this page needs: a typed, single-use confirmation code. */
type Gate = { confirmSecret: string; mfaCode?: string };
type GateBody = () => Gate | null;

/** A revealed secret only ever belongs to the row it came from. */
type Revealed = { id: string; label: string; secret: string | null; notes: string | null };

interface VaultItem {
  id: string;
  workspaceId: string | null;
  label: string;
  description: string;
  kind: Kind;
  /** "inferred" when the server read the kind off the label; those rows never get a health check. */
  kindSource: "explicit" | "inferred";
  /** Service the key belongs to, e.g. "openrouter". Always from the API, never derived here. */
  group: string;
  username: string | null;
  url: string | null;
  urlKind: UrlKind | null;
  hasSecret: boolean;
  hasNotes: boolean;
  healthStatus: Health;
  healthDetail: string | null;
  staleSince: string | null;
  createdAt: string;
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

/** Ascending health sorts the keys that need attention to the top. */
const HEALTH_RANK: Record<Health, number> = { stale: 0, weak: 1, unchecked: 2, healthy: 3 };

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

const KINDS: Array<{ value: Kind; label: string }> = [
  { value: "login", label: "Login" },
  { value: "token", label: "Token" },
  { value: "url", label: "URL" },
  { value: "note", label: "Note" },
];

const HEALTHS: Array<{ value: Health; label: string }> = [
  { value: "healthy", label: "Healthy" },
  { value: "weak", label: "Weak" },
  { value: "stale", label: "Stale" },
  { value: "unchecked", label: "Unchecked" },
];

const SCOPES = [
  { value: "all", label: "All keys" },
  { value: "account", label: "Account" },
  { value: "workspace", label: "This workspace" },
] as const;

/** Rows per page. A service with fewer keys still shows a footer, so the shape never jumps. */
const PAGE_SIZE = 10;

type Scope = (typeof SCOPES)[number]["value"];
type SortKey = "label" | "kind" | "health" | "newest";
type SortDir = "asc" | "desc";
type KindFilter = "all" | Kind;
type HealthFilter = "all" | Health;

function relayUrl(routeKey: string): string {
  return `${window.location.origin}/api/vault/relay/${routeKey}`;
}

function timeOf(value: string | null | undefined): number {
  if (!value) return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function canHaveRoutes(item: VaultItem): boolean {
  return item.kind === "token" || item.kind === "login";
}

/** The chevron opens the row's detail area. Only tokens and logins also carry routes there. */
function detailToggleLabel(item: VaultItem, open: boolean): string {
  if (canHaveRoutes(item)) return open ? "Hide routes" : "Show routes";
  return open ? "Hide details" : "Show details";
}

/** "openrouter" -> "Openrouter", "cloudflare_r2" -> "Cloudflare r2". */
function displayGroup(name: string): string {
  const cleaned = name.replace(/[-_]+/g, " ").trim();
  if (!cleaned) return "Ungrouped";
  return cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
}

function groupNeedsAttention(items: VaultItem[]): boolean {
  return items.some((item) => item.healthStatus === "stale" || item.healthStatus === "weak");
}

/**
 * Inferred keys are read off the label, so they never carry a health check. An em dash says
 * "nothing to check here" instead of a permanent "unchecked" pill on all 171 rows.
 */
function HealthMark({ item }: { item: VaultItem }) {
  if (item.kindSource === "inferred" && item.healthStatus === "unchecked") {
    return (
      <span className="text-xs text-muted-foreground/60" title="kind read from the label — nothing to check">
        —
      </span>
    );
  }
  return (
    <span title={item.healthDetail ?? undefined}>
      <StatusPill tone={HEALTH_TONE[item.healthStatus]} dot>
        {item.healthStatus}
      </StatusPill>
    </span>
  );
}

export function VaultView({
  workspace,
  me,
}: {
  workspace: Workspace | null;
  me: MeResponse | null;
}) {
  const queryClient = useQueryClient();
  const challenge = useConfirmChallenge(true);
  const [gateOpen, setGateOpen] = useState(false);
  const [typed, setTyped] = useState("");
  const [mfaCode, setMfaCode] = useState("");
  const [codeUsed, setCodeUsed] = useState(false);
  const [scope, setScope] = useState<Scope>("all");
  const [rawSecret, setRawSecret] = useState<string | null>(null);

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

  /** The gate is no longer a panel on the page: it opens the moment a write needs it. */
  const gate: GateBody = () => {
    const secret = typed.trim();
    const needsMfa = Boolean(me?.mfaEnabled) && !mfaCode.trim();
    if (!secret || needsMfa) {
      setGateOpen(true);
      toast.error(needsMfa && secret ? "Add the authenticator code too." : "Type the confirmation code first.");
      return null;
    }
    return { confirmSecret: secret, mfaCode: me?.mfaEnabled ? mfaCode.trim() : undefined };
  };

  function afterGate() {
    setTyped("");
    setMfaCode("");
    setCodeUsed(true);
    void challenge.refresh().finally(() => setCodeUsed(false));
  }

  function onGateError(error: unknown) {
    const code = errorCode(error);
    if (code === "CONFIRM_CODE_INVALID" || code === "CONFIRM_SECRET_INVALID") {
      // The code was mistyped, already used, or expired while the page sat open.
      // Fetch a live one instead of leaving the stale value on screen.
      setTyped("");
      void challenge.refresh();
      setGateOpen(true);
      toast.error(errorMessage(error));
      return;
    }
    toast.error(errorMessage(error));
  }

  async function reload() {
    await Promise.all([itemsQuery.refetch(), grantsQuery.refetch(), leasesQuery.refetch()]);
    await queryClient.invalidateQueries({ queryKey: ["vault-routes"] });
  }

  return (
    <div data-testid="view-vault" className="animate-fade-rise space-y-6">
      <Panel
        eyebrow="Cabinet"
        title="Keys"
        action={
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="h-8 gap-2 text-xs"
            aria-haspopup="dialog"
            onClick={() => setGateOpen(true)}
          >
            <ShieldCheck className="h-3.5 w-3.5 text-primary" />
            Confirmation
            <code className="num rounded bg-primary/10 px-1.5 py-0.5 text-[11px] font-semibold tracking-[0.18em] text-primary">
              {challenge.code ?? "······"}
            </code>
          </Button>
        }
      >
        <p className="max-w-3xl px-5 py-4 text-sm leading-relaxed text-muted-foreground">
          Everything you keep for an agent lives here. Account keys follow you into every workspace;
          workspace keys stay on the one you assign. Pick a service to narrow the list, search within it, or
          open a key's routes to see where an agent can send it. When it is time to hand a cabinet over, mint a
          temporary grant and give the agent that — never the stored secret.
        </p>
      </Panel>

      <Dialog open={gateOpen} onOpenChange={setGateOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Confirmation code</DialogTitle>
            <DialogDescription>
              Every save, import, mint, remove and revoke on this page uses one code. It is single-use, so
              a fresh one is issued the moment you use it.
            </DialogDescription>
          </DialogHeader>
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
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setGateOpen(false)}>
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <MintGrant
        workspace={workspace}
        onMinted={(secret) => {
          setRawSecret(secret);
          afterGate();
          void reload();
        }}
        gate={gate}
        onError={onGateError}
      />

      {rawSecret ? (
        <OneTimeSecret
          label="Vault grant"
          value={rawSecret}
          hint="Paste this into the agent. It expires on its own. Octo keeps only a hash."
          onDismiss={() => setRawSecret(null)}
        />
      ) : null}

      <div className="flex flex-wrap items-center gap-3">
        <div role="group" aria-label="Scope" className="inline-flex overflow-hidden rounded-md border border-border">
          {SCOPES.map((option) => (
            <button
              key={option.value}
              type="button"
              aria-pressed={scope === option.value}
              onClick={() => setScope(option.value)}
              className={cn(
                "h-8 px-3 text-xs font-medium transition-colors",
                scope === option.value
                  ? "bg-primary text-primary-foreground"
                  : "bg-card text-muted-foreground hover:text-foreground",
              )}
            >
              {option.label}
            </button>
          ))}
        </div>
        <p className="num text-xs text-muted-foreground">
          {items.length} keys · {accountItems.length} account · {workspaceItems.length} workspace
        </p>
      </div>

      {scope === "all" || scope === "account" ? (
        <Cabinet
          idPrefix="vault-account"
          title="Account"
          eyebrow="Every workspace"
          items={accountItems}
          loading={itemsQuery.isPending}
          error={itemsQuery.isError ? errorMessage(itemsQuery.error) : null}
          onRetry={() => void itemsQuery.refetch()}
          workspaceId={null}
          scopeKey={scope}
          gate={gate}
          onSaved={() => {
            afterGate();
            void reload();
          }}
          onError={onGateError}
        />
      ) : null}

      {scope === "all" || scope === "workspace" ? (
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
          scopeKey={scope}
          gate={gate}
          onSaved={() => {
            afterGate();
            void reload();
          }}
          onError={onGateError}
        />
      ) : null}

      <Panel
        eyebrow="Grants"
        title="Temporary keys"
        action={
          <Button
            size="sm"
            variant="outline"
            className="h-8 gap-1.5 text-xs"
            onClick={async () => {
              const body = gate();
              if (!body) return;
              try {
                const result = await api.post<{ purged: number }>("/api/vault/health", body);
                toast.success(
                  result.purged ? `Checked keys and routes. Removed ${result.purged} stale.` : "Checked keys and routes.",
                );
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
                      const body = gate();
                      if (!body) return;
                      try {
                        await api.del(`/api/vault/grants/${grant.id}`, body);
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
        gate={gate}
        onError={onGateError}
        onRevoked={() => {
          afterGate();
          void reload();
        }}
      />
    </div>
  );
}

function SortHeader({
  column,
  label,
  sortKey,
  sortDir,
  onSort,
}: {
  column: SortKey;
  label: string;
  sortKey: SortKey;
  sortDir: SortDir;
  onSort: (key: SortKey) => void;
}) {
  const active = sortKey === column;
  const Icon = !active ? ChevronsUpDown : sortDir === "asc" ? ArrowUp : ArrowDown;
  return (
    <button
      type="button"
      onClick={() => onSort(column)}
      className={cn(
        "inline-flex items-center gap-1 transition-colors hover:text-foreground",
        active && "text-foreground",
      )}
    >
      {label}
      <Icon className={cn("h-3 w-3", active ? "opacity-90" : "opacity-40")} />
    </button>
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
  gate: GateBody;
  onError: (error: unknown) => void;
  onRevoked: () => void;
}) {
  const queryClient = useQueryClient();

  async function revoke(lease: VaultLease) {
    const body = gate();
    if (!body) return;
    try {
      await api.del(`/api/vault/leases/${lease.id}`, body);
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
  gate: GateBody;
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
    const body = gate();
    if (!body) return;
    setBusy(true);
    try {
      const result = await api.post<{ rawSecret: string }>("/api/vault/grants", {
        name: name.trim(),
        expiresInHours: Number(hours),
        workspaceId: scope === "workspace" ? workspace?.id : null,
        ...body,
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
  scopeKey,
  gate,
  onSaved,
  onError,
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
  /** The scope tab this cabinet is drawn under. A change to it drops the selection. */
  scopeKey: string;
  gate: GateBody;
  onSaved: () => void;
  onError: (error: unknown) => void;
}) {
  const [label, setLabel] = useState("");
  const [description, setDescription] = useState("");
  const [kind, setKind] = useState<Kind>("token");
  const [urlKind, setUrlKind] = useState<UrlKind>("api_base");
  const [username, setUsername] = useState("");
  const [url, setUrl] = useState("");
  const [secret, setSecret] = useState("");
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);

  const [filter, setFilter] = useState("");
  const [kindFilter, setKindFilter] = useState<KindFilter>("all");
  const [healthFilter, setHealthFilter] = useState<HealthFilter>("all");
  const [sortKey, setSortKey] = useState<SortKey>("label");
  const [sortDir, setSortDir] = useState<SortDir>("asc");

  /** The one row whose detail area is open — for its routes, its secret, or both. */
  const [openId, setOpenId] = useState<string | null>(null);
  const [revealed, setRevealed] = useState<Revealed | null>(null);
  const [editing, setEditing] = useState<VaultItem | null>(null);

  /** Service scope picked in the rail. null means every service. */
  const [service, setService] = useState<string | null>(null);
  const [page, setPage] = useState(1);

  const [addOpen, setAddOpen] = useState<boolean | null>(null);
  const [bulkOpen, setBulkOpen] = useState(false);
  const [bulkText, setBulkText] = useState("");
  const [bulkBusy, setBulkBusy] = useState(false);

  /** Keys checked for a bulk delete. The set outlives paging; a narrowing change drops it. */
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkDeleting, setBulkDeleting] = useState(false);

  // Closed once the cabinet holds keys, open while it is still empty.
  const addFormOpen = addOpen ?? items.length === 0;

  /** Rail index: every service in the cabinet at its unfiltered size, so the counts never move. */
  const services = useMemo(() => {
    const buckets = new Map<string, VaultItem[]>();
    for (const item of items) {
      const name = item.group || "ungrouped";
      const bucket = buckets.get(name);
      if (bucket) bucket.push(item);
      else buckets.set(name, [item]);
    }
    return [...buckets.entries()]
      .map(([name, groupItems]) => ({ name, items: groupItems }))
      .sort((a, b) => displayGroup(a.name).localeCompare(displayGroup(b.name)));
  }, [items]);

  /** The same services under a five-letter band: A–E, F–J, … U–Z, then # for anything else. */
  const serviceLetters = useMemo(() => {
    const bands = new Map<string, Array<{ name: string; items: VaultItem[] }>>();
    for (const group of services) {
      const first = displayGroup(group.name).charAt(0).toUpperCase();
      const code = first.charCodeAt(0) - 65;
      const start = code >= 0 && code < 26 ? Math.floor(code / 5) * 5 : null;
      const end = start === null ? 0 : Math.min(start + 4, 25);
      const band = start === null ? "#" : `${String.fromCharCode(65 + start)}–${String.fromCharCode(65 + end)}`;
      const bucket = bands.get(band);
      if (bucket) bucket.push(group);
      else bands.set(band, [group]);
    }
    // Services are already in display-name order, so each band keeps that order.
    return [...bands.entries()].sort(([a], [b]) => (a === "#" ? -1 : b === "#" ? 1 : a.localeCompare(b)));
  }, [services]);

  /** The selected service's keys, before search and dropdowns narrow them further. */
  const scopeItems = useMemo(
    () => (service ? items.filter((item) => (item.group || "ungrouped") === service) : items),
    [items, service],
  );

  const visible = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    const matches = scopeItems.filter((item) => {
      if (kindFilter !== "all" && item.kind !== kindFilter) return false;
      if (healthFilter !== "all" && item.healthStatus !== healthFilter) return false;
      if (!needle) return true;
      return `${item.label} ${item.description} ${item.url ?? ""}`.toLowerCase().includes(needle);
    });
    const direction = sortDir === "asc" ? 1 : -1;
    return [...matches].sort((a, b) => {
      if (sortKey === "kind") return a.kind.localeCompare(b.kind) * direction;
      if (sortKey === "health") return (HEALTH_RANK[a.healthStatus] - HEALTH_RANK[b.healthStatus]) * direction;
      if (sortKey === "newest") return (timeOf(a.createdAt) - timeOf(b.createdAt)) * direction;
      return a.label.localeCompare(b.label) * direction;
    });
  }, [scopeItems, filter, kindFilter, healthFilter, sortKey, sortDir]);

  const pageCount = Math.max(1, Math.ceil(visible.length / PAGE_SIZE));
  const currentPage = Math.min(page, pageCount);
  const pageStart = (currentPage - 1) * PAGE_SIZE;
  const pageRows = visible.slice(pageStart, pageStart + PAGE_SIZE);

  const scopeLabel = service ? displayGroup(service) : "All services";
  const scopeCount =
    visible.length === scopeItems.length
      ? `${scopeItems.length} key${scopeItems.length === 1 ? "" : "s"}`
      : `${visible.length} of ${scopeItems.length} keys`;
  const rangeLabel = `${visible.length === 0 ? 0 : pageStart + 1}–${pageStart + pageRows.length} of ${visible.length}`;

  /** How many rows in front of you are checked, so the header box can read all / some / none. */
  const pageSelected = pageRows.filter((row) => selected.has(row.id)).length;
  const allPageSelected = pageRows.length > 0 && pageSelected === pageRows.length;

  /** Chips are the same filter model the controls drive, one per active narrowing. */
  const chips: Array<{ key: string; label: string; clear: () => void }> = [];
  if (filter.trim()) {
    chips.push({ key: "search", label: `“${filter.trim()}”`, clear: () => setFilter("") });
  }
  if (kindFilter !== "all") {
    chips.push({
      key: "kind",
      label: KINDS.find((choice) => choice.value === kindFilter)?.label ?? kindFilter,
      clear: () => setKindFilter("all"),
    });
  }
  if (healthFilter !== "all") {
    chips.push({
      key: "health",
      label: HEALTHS.find((choice) => choice.value === healthFilter)?.label ?? healthFilter,
      clear: () => setHealthFilter("all"),
    });
  }
  if (service) {
    chips.push({ key: "service", label: displayGroup(service), clear: () => setService(null) });
  }

  const bulkLines = bulkText.split("\n").map((line) => line.trim()).filter(Boolean);

  /**
   * Any change to search, a dropdown or the service scope puts the list back on page 1 and
   * drops the selection: a checked row must never be one the person can no longer see.
   */
  function narrow(apply: () => void) {
    apply();
    setPage(1);
    setSelected(new Set());
  }

  function clearFilters() {
    setFilter("");
    setKindFilter("all");
    setHealthFilter("all");
    setService(null);
    setPage(1);
    setSelected(new Set());
  }

  function clearSelection() {
    setSelected(new Set());
  }

  function toggleSelected(id: string, checked: boolean) {
    setSelected((current) => {
      const next = new Set(current);
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  /** The header box works on the rows in front of you, never on the whole cabinet. */
  function togglePage(checked: boolean) {
    setSelected((current) => {
      const next = new Set(current);
      for (const row of pageRows) {
        if (checked) next.add(row.id);
        else next.delete(row.id);
      }
      return next;
    });
  }

  function toggleSort(key: SortKey) {
    if (sortKey === key) {
      setSortDir((current) => (current === "asc" ? "desc" : "asc"));
      return;
    }
    setSortKey(key);
    setSortDir(key === "newest" ? "desc" : "asc");
  }

  function toggleDetail(id: string) {
    setOpenId((current) => (current === id ? null : id));
    // Only one row is open at a time, so opening another one drops the secret with it.
    setRevealed(null);
  }

  // A secret never outlives its row: a page, scope or filter change that pushes the
  // item out of the table closes the detail and drops the value. The same guard covers
  // a reveal that lands after its detail was closed again.
  useEffect(() => {
    if (openId && !pageRows.some((row) => row.id === openId)) setOpenId(null);
    if (revealed && (revealed.id !== openId || !pageRows.some((row) => row.id === revealed.id))) {
      setRevealed(null);
    }
  }, [openId, revealed, pageRows]);

  // The scope tabs decide which cabinet holds what, so a checked row does not survive them.
  useEffect(() => {
    setSelected(new Set());
  }, [scopeKey]);

  // A key removed from the row menu is gone from the cabinet too: drop its check with it.
  useEffect(() => {
    setSelected((current) => {
      if (current.size === 0) return current;
      const alive = new Set(items.map((item) => item.id));
      const next = new Set([...current].filter((id) => alive.has(id)));
      return next.size === current.size ? current : next;
    });
  }, [items]);

  async function importMany() {
    if (bulkLines.length === 0) {
      toast.error("Paste at least one LABEL=value line");
      return;
    }
    const body = gate();
    if (!body) return;
    setBulkBusy(true);
    try {
      const result = await api.post<{ inserted: number }>("/api/vault/items/bulk", {
        lines: bulkLines,
        workspaceId,
        ...body,
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
    const body = gate();
    if (!body) return;
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
        ...body,
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

  /** Open the row first, then fill its detail area. The secret lands where the eye already is. */
  async function reveal(item: VaultItem) {
    setOpenId(item.id);
    try {
      const result = await api.get<{ item: { label: string; secret: string | null; notes: string | null } }>(
        `/api/vault/items/${item.id}`,
      );
      setRevealed({
        id: item.id,
        label: result.item.label,
        secret: result.item.secret,
        notes: result.item.notes,
      });
    } catch (caught) {
      onError(caught);
    }
  }

  async function remove(item: VaultItem) {
    const body = gate();
    if (!body) return;
    try {
      await api.del(`/api/vault/items/${item.id}`, body);
      toast.success("Removed");
      onSaved();
    } catch (caught) {
      onError(caught);
    }
  }

  /** The same gate as a single remove, once for the whole checked set. */
  async function removeSelected() {
    const ids = [...selected];
    if (ids.length === 0) return;
    const body = gate();
    if (!body) return;
    setBulkDeleting(true);
    try {
      const result = await api.post<{ deleted: number }>("/api/vault/items/bulk-delete", { ids, ...body });
      setSelected(new Set());
      toast.success(`Removed ${result.deleted} key${result.deleted === 1 ? "" : "s"}`);
      onSaved();
    } catch (caught) {
      onError(caught);
    } finally {
      setBulkDeleting(false);
    }
  }

  function rowMenu(item: VaultItem) {
    const detailOpen = openId === item.id;
    return (
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            aria-label={`Actions for ${item.label}`}
            className="h-7 w-7 p-0 text-muted-foreground hover:text-foreground"
          >
            <MoreHorizontal className="h-4 w-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-44">
          <DropdownMenuItem onSelect={() => void reveal(item)}>
            <Eye className="mr-2 h-3.5 w-3.5" /> Show
          </DropdownMenuItem>
          <DropdownMenuItem data-testid={`vault-edit-${item.id}`} onSelect={() => setEditing(item)}>
            <Pencil className="mr-2 h-3.5 w-3.5" /> Edit
          </DropdownMenuItem>
          {canHaveRoutes(item) ? (
            <DropdownMenuItem onSelect={() => toggleDetail(item.id)}>
              <Link2 className="mr-2 h-3.5 w-3.5" /> {detailOpen ? "Hide routes" : "Routes"}
            </DropdownMenuItem>
          ) : null}
          <DropdownMenuSeparator />
          <DropdownMenuItem
            onSelect={() => void remove(item)}
            className="text-destructive focus:text-destructive"
          >
            <Trash2 className="mr-2 h-3.5 w-3.5" /> Remove
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    );
  }

  return (
    <Panel
      eyebrow={eyebrow}
      title={title}
      action={
        <>
          <StatusPill tone="muted">{items.length}</StatusPill>
          {disabled ? null : (
            <Button
              type="button"
              size="sm"
              variant={addFormOpen ? "ghost" : "outline"}
              className="h-8 gap-1.5 text-xs"
              data-testid={`${idPrefix}-add-toggle`}
              aria-expanded={addFormOpen}
              onClick={() => setAddOpen(!addFormOpen)}
            >
              {addFormOpen ? <X className="h-3.5 w-3.5" /> : <Plus className="h-3.5 w-3.5" />}
              {addFormOpen ? "Close" : "Add a key"}
            </Button>
          )}
        </>
      }
    >
      <div className="divide-y divide-border">
        {disabled ? (
          <p className="px-5 py-4 text-sm text-muted-foreground">
            Create a workspace before assigning keys to one.
          </p>
        ) : (
          <>
            {addFormOpen ? (
              <div className="p-5">
                <div className="grid gap-3 rounded-md border border-border bg-muted/30 p-4 sm:grid-cols-2">
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
                        {KINDS.map((choice) => (
                          <SelectItem key={choice.value} value={choice.value}>
                            {choice.label}
                          </SelectItem>
                        ))}
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
                    <Label htmlFor={`${idPrefix}-secret`}>
                      {kind === "login" ? "Password" : kind === "token" ? "Token" : "Secret"}
                    </Label>
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
                  <div className="flex items-center gap-2 sm:col-span-2">
                    <Button type="button" disabled={busy} onClick={() => void save()}>
                      Save key
                    </Button>
                    <p className="text-[11px] text-muted-foreground">
                      Needs the confirmation code. The code refreshes after each save.
                    </p>
                  </div>
                </div>
              </div>
            ) : null}

            <div className="p-5">
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
                      <p className="max-w-xl text-[11px] leading-relaxed text-muted-foreground">
                        One key per line, LABEL=value. Octo reads the kind from the label —{" "}
                        <code className="num">_URL</code> rows become URLs,{" "}
                        <code className="num">_KEY</code>/<code className="num">_TOKEN</code> rows become tokens,
                        everything else is kept as a note.
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
            </div>
          </>
        )}

        {disabled ? null : error ? (
          <EmptyState
            title="Could not load keys"
            description={error}
            action={<Button onClick={onRetry}>Retry</Button>}
          />
        ) : loading ? (
          <div className="space-y-2 p-5">
            <div className="h-9 animate-pulse rounded-md bg-muted" />
            <div className="h-9 animate-pulse rounded-md bg-muted" />
            <div className="h-9 animate-pulse rounded-md bg-muted" />
          </div>
        ) : items.length === 0 ? (
          <EmptyState
            motif="keys"
            title="Nothing stored here yet"
            description="Add a login, a token, a URL or a note. An agent only ever sees the cabinet a grant points at."
          />
        ) : (
          <>
            {selected.size > 0 ? (
              <div
                data-testid="vault-bulk-bar"
                className="flex flex-wrap items-center gap-2 border-b border-border bg-accent/40 px-4 py-2.5"
              >
                <p data-testid="vault-bulk-count" className="flex items-baseline gap-1.5 text-xs text-foreground">
                  <span className="num font-semibold">{selected.size}</span>
                  {" selected"}
                </p>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  data-testid="vault-bulk-clear"
                  className="h-7 px-2 text-xs font-normal text-muted-foreground hover:text-foreground"
                  onClick={clearSelection}
                >
                  Clear
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="destructive"
                  data-testid="vault-bulk-delete"
                  className="ml-auto h-8 gap-1.5 text-xs max-sm:w-full"
                  disabled={bulkDeleting}
                  onClick={() => void removeSelected()}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                  {`Delete ${selected.size} key${selected.size === 1 ? "" : "s"}`}
                </Button>
              </div>
            ) : null}

            <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-2.5">
              <div className="relative min-w-[180px] flex-1">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                <Input
                  data-testid={`${idPrefix}-filter`}
                  value={filter}
                  onChange={(event) => narrow(() => setFilter(event.target.value))}
                  placeholder="Search label, description or url"
                  aria-label="Filter keys"
                  className="h-8 bg-background pl-8 text-sm"
                />
              </div>
              <Select value={kindFilter} onValueChange={(value) => narrow(() => setKindFilter(value as KindFilter))}>
                <SelectTrigger className="h-8 w-[116px] bg-background text-xs" aria-label="Filter by kind">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All kinds</SelectItem>
                  {KINDS.map((choice) => (
                    <SelectItem key={choice.value} value={choice.value}>
                      {choice.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select
                value={healthFilter}
                onValueChange={(value) => narrow(() => setHealthFilter(value as HealthFilter))}
              >
                <SelectTrigger className="h-8 w-[126px] bg-background text-xs" aria-label="Filter by health">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All health</SelectItem>
                  {HEALTHS.map((choice) => (
                    <SelectItem key={choice.value} value={choice.value}>
                      {choice.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button
                type="button"
                size="sm"
                variant={sortKey === "newest" ? "default" : "outline"}
                className="h-8 gap-1.5 text-xs"
                onClick={() => {
                  // Sorting hides nothing, so it keeps the selection; it still returns to page 1.
                  toggleSort("newest");
                  setPage(1);
                }}
              >
                {sortKey === "newest" && sortDir === "asc" ? (
                  <ArrowUp className="h-3.5 w-3.5" />
                ) : (
                  <ArrowDown className="h-3.5 w-3.5" />
                )}
                Newest
              </Button>
            </div>

            {chips.length > 0 ? (
              <div className="flex flex-wrap items-center gap-1.5 border-b border-border px-4 py-2">
                {chips.map((chip) => (
                  <button
                    key={chip.key}
                    type="button"
                    onClick={() => narrow(chip.clear)}
                    className="inline-flex items-center gap-1 rounded-full border border-border bg-muted px-2 py-0.5 text-[11px] text-foreground transition-colors hover:bg-accent"
                  >
                    {chip.label}
                    <X className="h-3 w-3 text-muted-foreground" />
                    <span className="sr-only">remove this filter</span>
                  </button>
                ))}
                <button
                  type="button"
                  onClick={clearFilters}
                  className="ml-1 text-[11px] text-muted-foreground underline underline-offset-2 transition-colors hover:text-foreground"
                >
                  Clear all
                </button>
              </div>
            ) : null}

            <div className="lg:flex lg:items-start">
              {/* Scope rail: picks the service the table shows. A chip row above the table on narrow screens. */}
              <nav
                aria-label="Services"
                className="flex shrink-0 items-center gap-1.5 overflow-x-auto border-b border-border px-4 py-2 lg:sticky lg:top-[76px] lg:max-h-[calc(100vh-96px)] lg:w-[176px] lg:flex-col lg:items-stretch lg:gap-0.5 lg:overflow-x-hidden lg:overflow-y-auto lg:border-b-0 lg:border-r lg:px-3 lg:py-3"
              >
                <p className="eyebrow hidden px-2 pb-1.5 lg:block">Services</p>
                <button
                  type="button"
                  aria-pressed={service === null}
                  onClick={() => narrow(() => setService(null))}
                  className={cn(
                    "flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md px-2 py-1 text-xs transition-colors lg:w-full",
                    service === null
                      ? "bg-accent text-foreground"
                      : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
                  )}
                >
                  <span className="truncate">All services</span>
                  <span className="num ml-auto text-[11px] text-muted-foreground/80">{items.length}</span>
                </button>
                {serviceLetters.map(([letter, letterGroups]) => (
                  <Fragment key={letter}>
                    {/* A landmark, not a control: the services under it stay the thing you click. */}
                    <p
                      data-testid={`vault-service-letter-${letter}`}
                      className="eyebrow hidden px-2 pb-1 pt-2.5 text-[10px] opacity-60 lg:block"
                    >
                      {letter}
                    </p>
                    {letterGroups.map((group) => {
                      const active = service === group.name;
                      return (
                        <button
                          key={group.name}
                          type="button"
                          aria-pressed={active}
                          onClick={() => narrow(() => setService(active ? null : group.name))}
                          className={cn(
                            "flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md px-2 py-1 text-xs transition-colors lg:w-full",
                            active
                              ? "bg-accent text-foreground"
                              : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
                          )}
                        >
                          <span className="truncate">{displayGroup(group.name)}</span>
                          {groupNeedsAttention(group.items) ? (
                            <span
                              className="h-1.5 w-1.5 shrink-0 rounded-full bg-warning"
                              title="has a weak or stale key"
                            />
                          ) : null}
                          <span className="num ml-auto text-[11px] text-muted-foreground/80">
                            {group.items.length}
                          </span>
                        </button>
                      );
                    })}
                  </Fragment>
                ))}
              </nav>

              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-border px-4 py-2">
                  <p className="flex items-baseline gap-2">
                    <span className="font-display text-sm font-semibold text-foreground">{scopeLabel}</span>
                    <span className="num text-xs text-muted-foreground">{scopeCount}</span>
                  </p>
                  <span className="num text-xs text-muted-foreground">{rangeLabel}</span>
                </div>

                <div data-testid={`${idPrefix}-items`}>
                  {visible.length === 0 ? (
                    <EmptyState
                      motif="keys"
                      title="No keys match these filters"
                      description="Nothing in this scope survives the search and the dropdowns."
                      action={
                        <Button type="button" variant="outline" onClick={clearFilters}>
                          Clear filters
                        </Button>
                      }
                    />
                  ) : (
                    <table className="data-table block w-full md:table md:table-fixed">
                      <thead className="hidden md:table-header-group">
                        <tr>
                          <th className="w-10 md:sticky md:top-0 md:z-10 md:bg-muted lg:top-[73px]">
                            <Checkbox
                              data-testid={`${idPrefix}-select-page`}
                              aria-label="Select all keys on this page"
                              className="data-[state=indeterminate]:bg-accent"
                              disabled={pageRows.length === 0}
                              checked={allPageSelected ? true : pageSelected > 0 ? "indeterminate" : false}
                              onCheckedChange={(state) => togglePage(state === true)}
                            />
                          </th>
                          <th
                            className="md:sticky md:top-0 md:z-10 md:bg-muted lg:top-[73px]"
                            aria-sort={sortKey === "label" ? (sortDir === "asc" ? "ascending" : "descending") : "none"}
                          >
                            <SortHeader column="label" label="Key" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />
                          </th>
                          <th
                            className="w-[104px] md:sticky md:top-0 md:z-10 md:bg-muted lg:top-[73px]"
                            aria-sort={sortKey === "kind" ? (sortDir === "asc" ? "ascending" : "descending") : "none"}
                          >
                            <SortHeader column="kind" label="Kind" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />
                          </th>
                          <th
                            className="w-[128px] md:sticky md:top-0 md:z-10 md:bg-muted lg:top-[73px]"
                            aria-sort={sortKey === "health" ? (sortDir === "asc" ? "ascending" : "descending") : "none"}
                          >
                            <SortHeader
                              column="health"
                              label="Health"
                              sortKey={sortKey}
                              sortDir={sortDir}
                              onSort={toggleSort}
                            />
                          </th>
                          <th className="w-12 text-right md:sticky md:top-0 md:z-10 md:bg-muted lg:top-[73px]">
                            <span className="sr-only">Actions</span>
                          </th>
                        </tr>
                      </thead>
                      <tbody className="block md:table-row-group">
                        {pageRows.map((item) => {
                          const detailOpen = openId === item.id;
                          const isSelected = selected.has(item.id);
                          // One line per key: label, then description and url, each truncated on its own.
                          const blurb =
                            item.description && item.description !== item.label ? item.description : null;
                          return (
                            <Fragment key={item.id}>
                              <tr
                                className={cn(
                                  "relative flex items-start border-b border-border/70 transition-colors md:table-row",
                                  isSelected && "bg-accent/60",
                                )}
                              >
                                {/* Stacked on narrow screens, so the box rides the row's first line. */}
                                <td className="flex shrink-0 items-start pl-3 pr-1 pt-3 md:table-cell md:w-10 md:px-2 md:py-2">
                                  <Checkbox
                                    data-testid={`vault-select-${item.id}`}
                                    aria-label={`Select ${item.label}`}
                                    checked={isSelected}
                                    onCheckedChange={(state) => toggleSelected(item.id, state === true)}
                                  />
                                </td>
                                <td className="block min-w-0 flex-1 py-2.5 pl-1 pr-12 align-middle md:table-cell md:px-4 md:py-2.5">
                                  {/* The cell's width comes from the fixed layout, so this row can truncate
                                      instead of stretching the table. */}
                                  <div className="flex w-full min-w-0 items-center gap-2 overflow-hidden">
                                    <button
                                      type="button"
                                      data-testid={`vault-routes-${item.id}-toggle`}
                                      aria-expanded={detailOpen}
                                      aria-label={detailToggleLabel(item, detailOpen)}
                                      onClick={() => toggleDetail(item.id)}
                                      className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                                    >
                                      <ChevronRight
                                        className={cn("h-3.5 w-3.5 transition-transform", detailOpen && "rotate-90")}
                                      />
                                    </button>
                                    <p className="num min-w-0 truncate text-[13px] font-medium leading-5 text-foreground md:max-w-[46%]">
                                      {item.label}
                                    </p>
                                    {blurb ? (
                                      <p className="hidden min-w-0 flex-1 truncate text-xs leading-5 text-muted-foreground md:block">
                                        {blurb}
                                      </p>
                                    ) : null}
                                    {item.url ? (
                                      <p
                                        title={item.url}
                                        className="num hidden max-w-[30%] shrink-0 truncate text-[11px] leading-5 text-muted-foreground/80 lg:block"
                                      >
                                        {item.url}
                                      </p>
                                    ) : null}
                                  </div>
                                <div className="mt-1 flex flex-wrap items-center gap-1.5 md:hidden">
                                  <StatusPill tone="muted">{item.kind}</StatusPill>
                                  <HealthMark item={item} />
                                </div>
                              </td>
                              <td className="hidden align-middle md:table-cell md:w-[104px] md:px-4 md:py-2">
                                <span title={item.kindSource === "inferred" ? "kind read from the label" : undefined}>
                                  <StatusPill tone="muted">{item.kind}</StatusPill>
                                </span>
                              </td>
                              <td className="hidden align-middle md:table-cell md:w-[128px] md:px-4 md:py-2">
                                <HealthMark item={item} />
                              </td>
                              <td className="absolute right-1 top-1.5 p-0 md:static md:table-cell md:w-12 md:px-2 md:py-2 md:text-right">
                                {rowMenu(item)}
                              </td>
                              </tr>
                              {detailOpen ? (
                                <tr className="block bg-muted/30 md:table-row">
                                  <td colSpan={5} className="block p-0 md:table-cell">
                                    <ItemDetail
                                      item={item}
                                      revealed={revealed?.id === item.id ? revealed : null}
                                      gate={gate}
                                      onError={onError}
                                      onChanged={onSaved}
                                      onReveal={() => void reveal(item)}
                                      onDismiss={() => setRevealed(null)}
                                    />
                                  </td>
                                </tr>
                              ) : null}
                            </Fragment>
                          );
                        })}
                      </tbody>
                    </table>
                  )}
                </div>

                {visible.length === 0 ? null : (
                  <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border px-4 py-2.5">
                    <span className="num text-xs text-muted-foreground">{rangeLabel}</span>
                    <div className="flex items-center gap-2">
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        className="h-7 text-xs"
                        disabled={currentPage <= 1}
                        onClick={() => setPage(currentPage - 1)}
                      >
                        Previous
                      </Button>
                      <span className="num text-xs text-muted-foreground">
                        Page {currentPage} of {pageCount}
                      </span>
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        className="h-7 text-xs"
                        disabled={currentPage >= pageCount}
                        onClick={() => setPage(currentPage + 1)}
                      >
                        Next
                      </Button>
                    </div>
                  </div>
                )}
              </div>
            </div>
          </>
        )}
      </div>

      {editing ? (
        <EditItem
          key={editing.id}
          item={editing}
          gate={gate}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            // A rewritten secret must not keep sitting in state beside the row.
            setRevealed((current) => (current?.id === editing.id ? null : current));
            onSaved();
          }}
          onError={onError}
        />
      ) : null}
    </Panel>
  );
}

function ItemDetail({
  item,
  revealed,
  gate,
  onError,
  onChanged,
  onReveal,
  onDismiss,
}: {
  item: VaultItem;
  revealed: { label: string; secret: string | null; notes: string | null } | null;
  gate: GateBody;
  onError: (error: unknown) => void;
  onChanged: () => void;
  onReveal: () => void;
  onDismiss: () => void;
}) {
  const queryClient = useQueryClient();
  const routable = canHaveRoutes(item);
  // The route form stays shut until asked for: most keys have no routes at all.
  const [formOpen, setFormOpen] = useState(false);
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
    // A note or a plain URL has no routes to fetch; its detail area only carries the secret.
    enabled: routable,
  });
  const routes = routesQuery.data?.routes ?? [];

  async function add() {
    if (!name.trim() || !baseUrl.trim()) {
      toast.error("Name the route and give it a base URL");
      return;
    }
    const body = gate();
    if (!body) return;
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
        ...body,
      });
      setName("");
      setBaseUrl("");
      setAuthHeader("");
      setBodyField("");
      setBasicUsername("");
      setRouteKey("");
      setFormOpen(false);
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
    const body = gate();
    if (!body) return;
    try {
      await api.del(`/api/vault/items/${item.id}/routes/${route.id}`, body);
      toast.success("Route removed");
      await queryClient.invalidateQueries({ queryKey: ["vault-routes", item.id] });
      onChanged();
    } catch (error) {
      onError(error);
    }
  }

  return (
    <div className="space-y-2.5 px-4 py-3 md:px-5" data-testid={`vault-routes-${item.id}`}>
      {/* The secret opens first, inside the row that asked for it — never above the page. */}
      {revealed ? (
        <OneTimeSecret
          label={revealed.label}
          value={revealed.secret || revealed.notes || ""}
          hint={
            revealed.notes && revealed.secret
              ? `Notes: ${revealed.notes}`
              : "Shown from this session only. Dismiss to clear it."
          }
          onDismiss={onDismiss}
        />
      ) : null}

      {/* Opening a row should tell you something even when it has no routes. */}
      {item.url || item.hasSecret || item.hasNotes || (item.description && item.description !== item.label) ? (
        <div className="space-y-1">
          {item.url ? <p className="num break-all text-[11px] text-muted-foreground">{item.url}</p> : null}
          {item.description && item.description !== item.label ? (
            <p className="text-xs leading-relaxed text-muted-foreground">{item.description}</p>
          ) : null}
          {item.hasSecret || item.hasNotes ? (
            <p className="flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
              {item.hasNotes ? "Notes attached." : "Secret stored."}
              <button
                type="button"
                onClick={onReveal}
                className="underline underline-offset-2 transition-colors hover:text-foreground"
              >
                Show
              </button>
            </p>
          ) : null}
        </div>
      ) : null}

      {!routable ? null : routesQuery.isPending ? (
        <div className="h-8 animate-pulse rounded-md bg-muted" />
      ) : routes.length === 0 ? (
        <p className="text-xs text-muted-foreground">No routes yet.</p>
      ) : (
        <ul className="space-y-1.5">
          {routes.map((route) => (
            <li key={route.id} className="flex flex-wrap items-center gap-2 rounded-md border border-border bg-card px-2 py-1.5">
              <span className="text-xs font-medium">{route.name}</span>
              <span className="num text-[11px] text-muted-foreground">{route.routeKey}</span>
              <StatusPill tone="muted">{route.authScheme}</StatusPill>
              <span title={route.healthDetail ?? undefined}>
                <StatusPill tone={ROUTE_TONE[route.healthStatus]}>{route.healthStatus}</StatusPill>
              </span>
              <span className="num min-w-0 max-w-full truncate text-[11px] text-muted-foreground">
                {route.baseUrl}
              </span>
              <span className="ml-auto flex items-center gap-1">
                <span className="num hidden min-w-0 max-w-full truncate text-[11px] text-muted-foreground sm:inline">
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

      {formOpen ? (
        <div className="space-y-2">
          <div className="grid gap-2 sm:grid-cols-2">
            <Input
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Route name, e.g. Fish Audio API"
              aria-label="Route name"
              className="h-8 bg-background text-sm"
            />
            <Input
              value={baseUrl}
              onChange={(event) => setBaseUrl(event.target.value)}
              placeholder="Base URL, e.g. https://api.fish.audio"
              aria-label="Base URL"
              className="h-8 bg-background text-sm"
            />
            <Select value={authScheme} onValueChange={(value) => setAuthScheme(value as AuthScheme)}>
              <SelectTrigger aria-label="Auth scheme" className="h-8 bg-background text-sm">
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
                className="h-8 bg-background text-sm"
              />
            ) : null}
            {authScheme === "body_json" || authScheme === "path" ? (
              <Input
                value={bodyField}
                onChange={(event) => setBodyField(event.target.value)}
                placeholder={authScheme === "path" ? "Path template, e.g. bot{key}/getMe" : "Body field, e.g. api_key"}
                aria-label="Body field or path template"
                className="h-8 bg-background text-sm"
              />
            ) : null}
            {authScheme === "basic" ? (
              <Input
                value={basicUsername}
                onChange={(event) => setBasicUsername(event.target.value)}
                placeholder="Basic username (optional)"
                aria-label="Basic username"
                className="h-8 bg-background text-sm"
              />
            ) : null}
            <Input
              value={routeKey}
              onChange={(event) => setRouteKey(event.target.value)}
              placeholder="Route key (optional, auto-generated)"
              aria-label="Route key"
              className="h-8 bg-background text-sm"
            />
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button type="button" size="sm" className="h-8 text-xs" disabled={busy} onClick={() => void add()}>
              Add route
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="h-8 text-xs"
              onClick={() => setFormOpen(false)}
            >
              Cancel
            </Button>
            <p className="text-[11px] text-muted-foreground">
              An agent attaches its working key where the vendor expects it and points its client at the relay URL.
            </p>
          </div>
        </div>
      ) : !routable ? null : (
        <Button type="button" size="sm" variant="outline" className="h-7 text-xs" onClick={() => setFormOpen(true)}>
          Add route
        </Button>
      )}
    </div>
  );
}

type EditFields = {
  label: string;
  description: string;
  kind: Kind;
  username: string;
  url: string;
  urlKind: UrlKind;
  notes: string;
};

/** The single-item read carries the notes. The list payload never does, and neither carries the secret. */
type StoredItem = {
  label: string;
  description: string | null;
  kind: Kind;
  username: string | null;
  url: string | null;
  urlKind: UrlKind | null;
  notes: string | null;
};

/**
 * Editing rewrites every field on the server, so the form sends all of them back and
 * starts from the stored values. The row already knows most of them; the notes only
 * arrive with the item read, so the form opens on the row's values and fills the rest
 * as that lands. The secret is never prefilled: an empty field leaves it alone.
 */
function EditItem({
  item,
  gate,
  onClose,
  onSaved,
  onError,
}: {
  item: VaultItem;
  gate: GateBody;
  onClose: () => void;
  onSaved: () => void;
  onError: (error: unknown) => void;
}) {
  const [fields, setFields] = useState<EditFields>({
    label: item.label,
    description: item.description,
    kind: item.kind,
    username: item.username ?? "",
    url: item.url ?? "",
    urlKind: item.urlKind ?? "api_base",
    notes: "",
  });
  const [secret, setSecret] = useState("");
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  // Whatever the person has typed wins over the fetch, even if it lands mid-keystroke.
  const touched = useRef(new Set<keyof EditFields>());

  function setField<K extends keyof EditFields>(key: K, value: EditFields[K]) {
    touched.current.add(key);
    setFields((current) => ({ ...current, [key]: value }));
  }

  useEffect(() => {
    let alive = true;
    setLoadError(null);
    api
      .get<{ item: StoredItem }>(`/api/vault/items/${item.id}`)
      .then((result) => {
        if (!alive) return;
        const detail = result.item;
        setFields((current) => ({
          label: touched.current.has("label") ? current.label : detail.label,
          description: touched.current.has("description") ? current.description : (detail.description ?? ""),
          kind: touched.current.has("kind") ? current.kind : detail.kind,
          username: touched.current.has("username") ? current.username : (detail.username ?? ""),
          url: touched.current.has("url") ? current.url : (detail.url ?? ""),
          urlKind: touched.current.has("urlKind") ? current.urlKind : (detail.urlKind ?? current.urlKind),
          notes: touched.current.has("notes") ? current.notes : (detail.notes ?? ""),
        }));
        setLoaded(true);
      })
      .catch((caught) => {
        if (alive) setLoadError(errorMessage(caught));
      });
    return () => {
      alive = false;
    };
  }, [item.id, attempt]);

  async function save() {
    // Sending a field the read never returned would clear it.
    if (!loaded) return;
    const body = gate();
    if (!body) return;
    setBusy(true);
    try {
      await api.patch(`/api/vault/items/${item.id}`, {
        label: fields.label,
        description: fields.description,
        kind: fields.kind,
        username: fields.username,
        url: fields.url,
        urlKind: fields.kind === "url" ? fields.urlKind : null,
        notes: fields.notes,
        ...(secret.trim() ? { secret: secret.trim() } : {}),
        ...body,
      });
      toast.success("Saved");
      onSaved();
    } catch (caught) {
      onError(caught);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent data-testid="vault-edit-dialog" className="max-h-[90vh] max-w-lg overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{item.label}</DialogTitle>
          <DialogDescription>
            Every field is written back as it stands here, so clear a field to clear it. Leave the
            secret blank to keep the one already stored.
          </DialogDescription>
        </DialogHeader>

        {loadError ? (
          <p className="flex flex-wrap items-center gap-2 text-xs text-destructive">
            Could not load the stored fields. {loadError}
            <button
              type="button"
              onClick={() => setAttempt((current) => current + 1)}
              className="underline underline-offset-2"
            >
              Try again
            </button>
          </p>
        ) : loaded ? null : (
          <p className="text-xs text-muted-foreground">Loading the stored fields…</p>
        )}

        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="vault-edit-label">Label</Label>
            <Input
              id="vault-edit-label"
              value={fields.label}
              onChange={(event) => setField("label", event.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="vault-edit-kind">Kind</Label>
            <Select
              value={fields.kind}
              onValueChange={(value) => {
                setField("kind", value as Kind);
                if (value !== "url") setField("urlKind", "api_base");
              }}
            >
              <SelectTrigger id="vault-edit-kind">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {KINDS.map((choice) => (
                  <SelectItem key={choice.value} value={choice.value}>
                    {choice.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="vault-edit-username">Username</Label>
            <Input
              id="vault-edit-username"
              value={fields.username}
              onChange={(event) => setField("username", event.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="vault-edit-url">URL</Label>
            <Input
              id="vault-edit-url"
              value={fields.url}
              onChange={(event) => setField("url", event.target.value)}
              placeholder="https://"
            />
          </div>
          {fields.kind === "url" ? (
            <div className="space-y-1.5">
              <Label htmlFor="vault-edit-url-kind">URL kind</Label>
              <Select
                value={fields.urlKind}
                onValueChange={(value) => setField("urlKind", value as UrlKind)}
              >
                <SelectTrigger id="vault-edit-url-kind">
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
            <Label htmlFor="vault-edit-description">Description</Label>
            <Input
              id="vault-edit-description"
              value={fields.description}
              onChange={(event) => setField("description", event.target.value)}
            />
          </div>
          <div className="space-y-1.5 sm:col-span-2">
            <Label htmlFor="vault-edit-secret">Secret</Label>
            <Input
              id="vault-edit-secret"
              type="password"
              autoComplete="off"
              value={secret}
              onChange={(event) => setSecret(event.target.value)}
            />
            <p className="text-[11px] text-muted-foreground">Leave blank to keep the current secret.</p>
          </div>
          <div className="space-y-1.5 sm:col-span-2">
            <Label htmlFor="vault-edit-notes">Notes</Label>
            <Input
              id="vault-edit-notes"
              value={fields.notes}
              onChange={(event) => setField("notes", event.target.value)}
            />
          </div>
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="button"
            data-testid="vault-edit-save"
            disabled={busy || !loaded}
            onClick={() => void save()}
          >
            {busy ? "Saving…" : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
