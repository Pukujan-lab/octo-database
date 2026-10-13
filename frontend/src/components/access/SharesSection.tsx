import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
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
import { OneTimeSecret } from "@/components/portal/OneTimeSecret";
import { api, errorMessage } from "@/lib/api";
import { formatDate, formatDateTime, formatRelative } from "@/lib/format";
import { shareState } from "@/components/portal/file-status";
import type { ShareRow } from "@/lib/types";
import type { QueryLike } from "@/lib/query-types";
import { MoreVertical, Plus, Share2, Trash2 } from "lucide-react";
import { toast } from "@/utils/toast";

type ExpiryChoice = "none" | "1" | "24" | "168" | "720";

const EXPIRY_OPTIONS: Array<{ value: ExpiryChoice; label: string }> = [
  { value: "none", label: "No expiry" },
  { value: "1", label: "1 hour" },
  { value: "24", label: "24 hours" },
  { value: "168", label: "7 days" },
  { value: "720", label: "30 days" },
];

export function SharesSection({
  workspaceId,
  query,
  reload,
}: {
  workspaceId: string;
  query: QueryLike<ShareRow[]>;
  reload: () => void;
}) {
  const shares = query.data ?? [];
  const [filter, setFilter] = useState("");
  const [mode, setMode] = useState<"table" | "cards">("table");
  const [expiry, setExpiry] = useState<ExpiryChoice>("24");
  const [shareUrl, setShareUrl] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const filtered = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    if (!needle) return shares;
    return shares.filter((share) =>
      [share.tokenPrefix, share.resourceType, share.permission, shareState(share).label]
        .join(" ")
        .toLowerCase()
        .includes(needle),
    );
  }, [shares, filter]);

  async function createLink() {
    setCreating(true);
    try {
      const result = await api.post<{ shareUrl: string; rawToken: string }>("/api/workspaces/shares", {
        workspaceId,
        resourceType: "gallery",
        permission: "read",
        expiresInHours: expiry === "none" ? undefined : Number(expiry),
      });
      // The API returns the relative path; the viewer is addressed absolutely.
      const absolute = /^https?:/i.test(result.shareUrl) ? result.shareUrl : `${window.location.origin}${result.shareUrl}`;
      setShareUrl(absolute);
      toast.success("Share link created — copy it now");
      reload();
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setCreating(false);
    }
  }

  async function revoke(share: ShareRow) {
    try {
      await api.del<{ success: boolean }>(`/api/shares/${share.id}?workspaceId=${encodeURIComponent(workspaceId)}`);
      toast.success("Share link revoked");
      reload();
    } catch (error) {
      toast.error(errorMessage(error));
    }
  }

  const expiryLabel = EXPIRY_OPTIONS.find((option) => option.value === expiry)?.label ?? "No expiry";

  return (
    <Panel
      eyebrow="Public access"
      title="Share links"
      action={
        <ListToolbar
          value={filter}
          onChange={setFilter}
          placeholder="Filter links"
          mode={mode}
          onMode={setMode}
          right={
            <div className="flex items-center gap-2">
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button size="sm" variant="outline" className="h-8 gap-1.5 text-xs">
                    <Share2 className="h-3.5 w-3.5" /> {expiryLabel}
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  {EXPIRY_OPTIONS.map((option) => (
                    <DropdownMenuItem key={option.value} onSelect={() => setExpiry(option.value)}>
                      <span className="flex w-full items-center justify-between gap-3">
                        {option.label}
                        {option.value === expiry ? <span className="text-primary">•</span> : null}
                      </span>
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
              <Button
                data-testid="share-create"
                size="sm"
                className="h-8 gap-1.5 text-xs"
                onClick={() => void createLink()}
                disabled={creating}
              >
                <Plus className="h-4 w-4" /> {creating ? "Creating…" : "Create link"}
              </Button>
            </div>
          }
        />
      }
      bodyClassName="min-h-[220px]"
    >
      <div className="space-y-4 p-5">
        {shareUrl ? (
          <OneTimeSecret
            label="Share URL"
            value={shareUrl}
            hint="Anyone holding this link can read the gallery until it expires or you revoke it. It is never shown again."
            onDismiss={() => setShareUrl(null)}
          />
        ) : null}

        {query.isError ? (
          <ErrorState title="Could not load share links" detail={errorMessage(query.error)} onRetry={() => query.refetch()} />
        ) : query.isPending ? (
          <div className="space-y-2">
            {[0, 1].map((row) => (
              <Skeleton key={row} className="h-14 w-full" />
            ))}
          </div>
        ) : shares.length === 0 ? (
          <EmptyState
            title="No share links"
            description="Publish a read-only gallery link that expires on its own — no account required to open it."
            action={
              <Button size="sm" onClick={() => void createLink()} className="gap-2">
                <Plus className="h-4 w-4" /> Create link
              </Button>
            }
          />
        ) : filtered.length === 0 ? (
          <EmptyState
            title="No links match that filter"
            description={`${shares.length} link${shares.length === 1 ? "" : "s"} loaded, none matched “${filter}”.`}
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
                  <th>Token</th>
                  <th>State</th>
                  <th>Permission</th>
                  <th>Expiry</th>
                  <th className="hidden md:table-cell">Created</th>
                  <th>Visits</th>
                  <th className="text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((share) => {
                  const state = shareState(share);
                  return (
                    <tr key={share.id}>
                      <td className="num text-xs">{`${share.tokenPrefix}…`}</td>
                      <td>
                        <StatusPill tone={state.tone} dot>
                          {state.label}
                        </StatusPill>
                      </td>
                      <td className="num text-xs">{share.permission}</td>
                      <td className="whitespace-nowrap text-xs">
                        {share.validUntil ? (
                          formatDateTime(share.validUntil)
                        ) : (
                          <span className="text-muted-foreground">no expiry</span>
                        )}
                      </td>
                      <td className="hidden whitespace-nowrap text-xs text-muted-foreground md:table-cell">
                        {formatDate(share.createdAt)}
                      </td>
                      <td className="whitespace-nowrap text-xs">
                        <span className="num">{share.accessCount}</span>
                        <span className="text-muted-foreground">
                          {" visit"}
                          {share.accessCount === 1 ? "" : "s"}
                          {share.lastAccessedAt ? ` · ${formatRelative(share.lastAccessedAt)}` : ""}
                        </span>
                      </td>
                      <td className="text-right">
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button
                              size="icon"
                              variant="ghost"
                              className="h-8 w-8"
                              aria-label={`Actions for share ${share.tokenPrefix}`}
                            >
                              <MoreVertical className="h-4 w-4" />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end" className="w-44">
                            <DropdownMenuItem
                              className="gap-2 text-destructive focus:bg-destructive/10 focus:text-destructive"
                              onSelect={() => void revoke(share)}
                            >
                              <Trash2 className="h-4 w-4" /> Revoke
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {filtered.map((share) => {
              const state = shareState(share);
              return (
                <div key={share.id} className="panel space-y-3 p-4">
                  <div className="flex items-start justify-between gap-2">
                    <p className="num truncate text-sm font-medium">{`${share.tokenPrefix}…`}</p>
                    <StatusPill tone={state.tone} dot>
                      {state.label}
                    </StatusPill>
                  </div>
                  <dl className="space-y-1 text-[11px] text-muted-foreground">
                    <div className="flex justify-between gap-2">
                      <dt>Permission</dt>
                      <dd className="num text-foreground">{share.permission}</dd>
                    </div>
                    <div className="flex justify-between gap-2">
                      <dt>Resource</dt>
                      <dd className="num text-foreground">{share.resourceType}</dd>
                    </div>
                    <div className="flex justify-between gap-2">
                      <dt>Expires</dt>
                      <dd className="text-foreground">{share.validUntil ? formatDateTime(share.validUntil) : "no expiry"}</dd>
                    </div>
                    <div className="flex justify-between gap-2">
                      <dt>Visits</dt>
                      <dd className="num text-foreground">{share.accessCount}</dd>
                    </div>
                  </dl>
                  <Button size="sm" variant="outline" className="h-8 w-full gap-1.5 text-xs" onClick={() => void revoke(share)}>
                    <Trash2 className="h-3.5 w-3.5" /> Revoke link
                  </Button>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </Panel>
  );
}
