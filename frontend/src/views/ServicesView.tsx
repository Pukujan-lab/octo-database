import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Panel, StatusPill } from "@/components/portal/Panel";
import { ErrorState } from "@/components/portal/EmptyState";
import { errorMessage } from "@/lib/api";
import { useServices, useTraceLink } from "@/lib/queries";
import { ExternalLink } from "lucide-react";

/** Hosted services Octo fronts. Each one opens the tool's own UI; Octo builds no
 *  dashboard for them. A service with no URL configured shows as not set up.
 *  Traces open on this workspace's own Phoenix project. */
export function ServicesView({ workspaceId }: { workspaceId: string }) {
  const services = useServices();
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
          .map((service) => (
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
        ))}
      </div>
    </div>
  );
}
