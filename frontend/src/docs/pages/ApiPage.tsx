import { Callout, C, CodeBlock, EndpointTable, H2, H3, MethodChip, P, PageHeader, Table } from "@/docs/blocks";
import {
  AUTH_GUIDANCE,
  EXTRA_ROUTES,
  KEY_CLASSES,
  SCOPE_PRESETS,
  capabilityGroups,
} from "@/docs/api-catalogue";

export function ApiPage() {
  const groups = capabilityGroups();

  return (
    <>
      <PageHeader
        eyebrow="Reference"
        title="API reference"
        lead="Every call the server enforces, with its method, path, required scope and role. Generated from the same catalogue the server uses, so it cannot describe an action that does not exist."
      />

      <Callout title="Prefer discovery at runtime">
        This table is a snapshot. <C>GET /api/capabilities</C> is the live answer for a specific
        key: it already applies that key's scopes, its workspace binding, the caller's role, and
        which providers are configured. When the two disagree, the call is right.
      </Callout>

      <H2 id="authentication">Authentication</H2>
      <CodeBlock label="HTTP" code={AUTH_GUIDANCE.header} />
      <P>{AUTH_GUIDANCE.note}</P>

      <H2 id="roles">Required role</H2>
      <P>
        A capability marked with a role needs that role in the workspace in addition to its scope.
        Unmarked capabilities need only membership.
      </P>

      {groups.map((group) => (
        <section key={group.key}>
          <H2 id={group.key}>{group.label}</H2>
          <P>{group.blurb}</P>
          <EndpointTable
            rows={group.capabilities.map((capability) => ({
              action: capability.action,
              method: capability.method,
              path: capability.path,
              scope: capability.requiredScope,
              summary: capability.description,
            }))}
          />
        </section>
      ))}

      <H2 id="other">Other routes</H2>
      <P>
        These are on the HTTP surface but are not capability-gated, so they never appear in{" "}
        <C>/api/capabilities</C>.
      </P>
      <EndpointTable
        rows={EXTRA_ROUTES.map((route) => ({
          method: route.method,
          path: route.path,
          scope: route.scope,
          summary: route.summary,
        }))}
      />

      <H2 id="key-classes">Key classes</H2>
      <P>
        A class is a mint-time preset over the four real scopes — not a second authorization
        dimension. A key stores only its resolved scopes, and every route is still decided by its
        required scope.
      </P>
      <Table
        minWidth="34rem"
        columns={[
          { key: "class", label: "Class" },
          { key: "scopes", label: "Scopes" },
          { key: "reach", label: "Reach" },
        ]}
        rows={Object.entries(KEY_CLASSES).map(([id, profile]) => ({
          class: (
            <>
              <code className="font-mono text-[11px] text-foreground">{id}</code>
              <p className="mt-0.5 text-[11px] text-muted-foreground">{profile.label}</p>
            </>
          ),
          scopes: (
            <span className="whitespace-nowrap font-mono text-[11px] text-muted-foreground">
              {profile.scopes.join(", ")}
            </span>
          ),
          reach: profile.description,
        }))}
      />

      <H3 id="scope-presets">Scope presets</H3>
      <P>
        The picker in the dashboard maps these labels onto explicit scope lists:
      </P>
      <div className="my-4 flex flex-wrap gap-2">
        {SCOPE_PRESETS.map((preset) => (
          <span
            key={preset.id}
            className="inline-flex items-center gap-2 rounded-full border border-border bg-muted/40 px-3 py-1 text-[11px]"
          >
            <span className="font-medium text-foreground">{preset.label}</span>
            <span className="font-mono text-muted-foreground">{preset.scopes.join(", ")}</span>
          </span>
        ))}
      </div>

      <H2 id="status-codes">Status codes</H2>
      <Table
        minWidth="30rem"
        columns={[
          { key: "code", label: "Code" },
          { key: "means", label: "Means" },
        ]}
        rows={[
          ["200 / 201", "Success. 201 means a resource was created."],
          ["400", "The request is malformed — bad JSON, a missing field, an invalid UUID, a rejected statement."],
          ["401", "No credential, an expired one, or the wrong token family for this path."],
          ["403", "The credential is valid but lacks the scope, the role, or access to this workspace."],
          ["404", "The resource does not exist — or belongs to another workspace. A fenced resource never reports 403."],
          ["409", "A conflict: a slug is taken, a key class exists, a dataset version collided. Retry or change the input."],
          ["415", "The media type cannot be read."],
          ["429", "A rate limit, including one workspace creation per rolling day."],
          ["503", "An optional provider is not configured. The rest of Octo keeps working."],
        ].map(([code, means]) => ({
          code: <span className="num whitespace-nowrap text-foreground">{code}</span>,
          means,
        }))}
      />

      <H2 id="error-body">Error body</H2>
      <P>
        Errors are JSON with an <C>error</C> field. Many carry a machine-readable <C>code</C> and a
        human <C>message</C>; the machine code is the stable part, so branch on it rather than on
        prose.
      </P>
      <CodeBlock
        label="JSON"
        code={`{
  "error": "WORKSPACE_ACCESS_DENIED",
  "code": "WORKSPACE_ACCESS_DENIED",
  "message": "This credential cannot access the requested workspace."
}`}
      />

      <H2 id="conventions">Conventions</H2>
      <H3 id="fencing">Workspace fencing</H3>
      <P>
        Every path that names a workspace checks the key's binding and the caller's membership
        before touching data. A resource in another workspace answers <C>404</C> rather than{" "}
        <C>403</C>, so a caller cannot use the status code to learn that it exists.
      </P>
      <H3 id="idempotency">Idempotency</H3>
      <P>
        Job submission, dataset registration and analytics queries accept an{" "}
        <C>idempotencyKey</C>. A repeat with the same key returns the original result instead of
        creating a second one — which is what makes a retry safe.
      </P>
      <H3 id="pagination">Row limits</H3>
      <P>
        SQL responses default to 1000 rows and cap at 10000; a truncated result says so. Analytics
        row reads default to and cap at 500. Neither paginates for you — page in your own query.
      </P>

      <H2 id="quick-index">Every path, at a glance</H2>
      <div className="mt-4 space-y-1.5">
        {[
          ...groups.flatMap((group) =>
            group.capabilities.map((capability) => ({
              method: capability.method,
              path: capability.path,
            })),
          ),
          ...EXTRA_ROUTES.map((route) => ({ method: route.method, path: route.path })),
        ].map((row) => (
          <div key={`${row.method} ${row.path}`} className="flex items-center gap-2">
            <MethodChip method={row.method} />
            <code className="break-all font-mono text-[11px] text-muted-foreground">{row.path}</code>
          </div>
        ))}
      </div>
    </>
  );
}
