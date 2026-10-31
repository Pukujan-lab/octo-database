import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Panel, StatusPill } from "@/components/portal/Panel";
import { ErrorState } from "@/components/portal/EmptyState";
import { Input } from "@/components/ui/input";
import { api, errorMessage } from "@/lib/api";
import { useServices, useTraceLink, useUxAnalytics } from "@/lib/queries";
import { useQueryClient } from "@tanstack/react-query";
import { ExternalLink } from "lucide-react";
import { useState } from "react";

/** Hosted services Octo fronts. Each one opens the tool's own UI; Octo builds no
 *  dashboard for them. A service with no URL configured shows as not set up.
 *  Traces open on this workspace's own Phoenix project; UX analytics on its own
 *  Umami website. */
export function ServicesView({ workspaceId, role }: { workspaceId: string; role: string }) {
  const services = useServices();
  const uxReady = Boolean(services.data?.services.some((s) => s.id === "ux" && s.url));
  const tracesReady = Boolean(services.data?.services.some((s) => s.id === "traces" && s.url));
  const traceLink = useTraceLink(workspaceId, tracesReady);

  return (
    <div data-testid="view-services" className="animate-fade-rise space-y-6">
      {services.isPending ? <Skeleton className="h-40 w-full" /> : null}
      {services.isError ? (
        <ErrorState title="Could not load services" detail={errorMessage(services.error)} />
      ) : null}
      <div className="grid gap-6 md:grid-cols-2">
        {(services.data?.services ?? [])
          .map((service) =>
            service.id === "traces" && service.url && traceLink.data ? { ...service, url: traceLink.data.url } : service,
          )
          .map((service) =>
            service.id === "ux" && uxReady ? (
              <UxAnalyticsPanel key="ux" workspaceId={workspaceId} canTurnOn={role === "owner" || role === "admin"} />
            ) : (
          <Panel
            key={service.id}
            title={service.label}
            eyebrow={service.tool}
            action={
              <StatusPill tone={service.url ? "success" : "neutral"}>
                {service.url ? "Ready" : "Not set up"}
              </StatusPill>
            }
          >
            <div className="flex items-center justify-between gap-4 text-sm text-muted-foreground">
              <span>
                {service.url
                  ? `Open ${service.tool} to inspect it.`
                  : `Set the server's URL for ${service.tool} to enable this link.`}
              </span>
              {service.url ? (
                <Button asChild size="sm">
                  <a href={service.url} target="_blank" rel="noopener noreferrer">
                    Open <ExternalLink className="ml-1.5 h-3.5 w-3.5" aria-hidden="true" />
                  </a>
                </Button>
              ) : (
                <Button size="sm" disabled>
                  Open
                </Button>
              )}
            </div>
          </Panel>
            ),
        )}
      </div>
    </div>
  );
}

/** Clicks, replays (form fields masked) and heatmaps in the workspace's Umami
 *  website. Owners and admins turn it on with the app's domain; Open signs the
 *  member in to Umami. */
function UxAnalyticsPanel({ workspaceId, canTurnOn }: { workspaceId: string; canTurnOn: boolean }) {
  const ux = useUxAnalytics(workspaceId, true);
  const queryClient = useQueryClient();
  const [domain, setDomain] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const enabled = Boolean(ux.data?.enabled);

  async function turnOn() {
    setBusy(true);
    setError(null);
    try {
      await api.post(`/api/workspaces/${workspaceId}/ux-analytics`, { domain });
      await queryClient.invalidateQueries({ queryKey: ["ux-analytics", workspaceId] });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function open() {
    // Open the tab now, inside the click, so the browser does not block it.
    const tab = window.open("about:blank", "_blank");
    setError(null);
    try {
      const { url } = await api.get<{ url: string }>(`/api/workspaces/${workspaceId}/ux-analytics/link`);
      if (tab) tab.location.href = url;
      else window.location.href = url;
    } catch (err) {
      tab?.close();
      setError(errorMessage(err));
    }
  }

  return (
    <Panel
      title="UX analytics"
      eyebrow="Umami"
      action={<StatusPill tone={enabled ? "success" : "neutral"}>{enabled ? "On" : "Off"}</StatusPill>}
    >
      <div className="space-y-3 text-sm text-muted-foreground">
        {enabled ? (
          <>
            <div className="flex items-center justify-between gap-4">
              <span>Clicks, session replays and heatmaps. Form fields are masked in replays.</span>
              <Button size="sm" onClick={open}>
                Open <ExternalLink className="ml-1.5 h-3.5 w-3.5" aria-hidden="true" />
              </Button>
            </div>
            <details>
              <summary className="cursor-pointer">Tracking code</summary>
              <pre className="mt-2 overflow-x-auto whitespace-pre rounded bg-muted p-2 text-xs">{ux.data?.tags}</pre>
            </details>
          </>
        ) : canTurnOn ? (
          <div className="flex items-center gap-2">
            <Input
              value={domain}
              onChange={(e) => setDomain(e.target.value)}
              placeholder="app.example.com"
              aria-label="App domain"
              className="h-8"
            />
            <Button size="sm" onClick={turnOn} disabled={busy || !domain.trim()}>
              {busy ? "Turning on" : "Turn on"}
            </Button>
          </div>
        ) : (
          <span>An owner or admin can turn this on.</span>
        )}
        {error ? <p className="text-destructive">{error}</p> : null}
      </div>
    </Panel>
  );
}
