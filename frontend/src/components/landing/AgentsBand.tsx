const CAPABILITIES_RESPONSE = `GET /api/capabilities
{
  "contractVersion": 1,
  "capabilities": [
    { "action": "workspaces.query", "method": "POST",
      "requiredScope": "read" },
    { "action": "files.publish", "method": "POST",
      "requiredScope": "write" }
  ]
}`;

/** Section 4: the agent-facing band, with a capability-discovery response. */
export function AgentsBand() {
  return (
    <section className="border-b border-border">
      <div className="mx-auto grid w-full max-w-6xl gap-8 px-5 py-14 sm:px-8 lg:grid-cols-2 lg:items-start lg:gap-16 lg:py-24">
        <div className="max-w-md">
          <h2 className="font-display text-2xl font-semibold tracking-tight sm:text-3xl">
            Built for agents, not just people.
          </h2>
          <p className="mt-3 text-sm leading-relaxed text-muted-foreground sm:text-base">
            The same capabilities are exposed over MCP at /mcp, with OAuth 2.1 for hosted clients
            and bearer keys for local agents. An agent discovers what it may do from the server,
            not from documentation that drifts.
          </p>
        </div>

        <div className="min-w-0 overflow-x-auto rounded-md border border-border bg-muted/40 p-4">
          <pre className="font-mono text-[11px] leading-relaxed text-muted-foreground sm:text-xs">
            <code>{CAPABILITIES_RESPONSE}</code>
          </pre>
        </div>
      </div>
    </section>
  );
}
