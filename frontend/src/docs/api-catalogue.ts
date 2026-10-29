/** The API reference reads the server's own capability catalogue rather than a
 *  copy of it. `src/api/capabilities.ts` is a pure data module with no imports,
 *  so the docs cannot describe an action the server does not enforce — adding a
 *  capability is the only way to add a row here. */
import {
  AUTH_GUIDANCE,
  KEY_CLASSES,
  OCTO_CAPABILITIES,
  SCOPE_PRESETS,
  type CapabilityDescriptor,
} from "../../../src/api/capabilities";

export { AUTH_GUIDANCE, KEY_CLASSES, OCTO_CAPABILITIES, SCOPE_PRESETS };
export type { CapabilityDescriptor };

/** Capabilities grouped by the noun their action name starts with, in the order
 *  a caller meets them. */
const GROUPS: { key: string; label: string; blurb: string }[] = [
  {
    key: "workspaces",
    label: "Workspaces",
    blurb: "The tenancy boundary: create it, list it, provision its database, run SQL in it.",
  },
  { key: "files", label: "Files", blurb: "Upload bytes, publish one file, archive cold, delete." },
  { key: "gallery", label: "Gallery", blurb: "Media in a workspace, with thumbnails." },
  { key: "jobs", label: "Jobs", blurb: "Background work: enqueue, list, run a pass." },
  { key: "datasets", label: "Datasets", blurb: "Immutable Parquet versions for analytics." },
  { key: "analytics", label: "Analytics", blurb: "Named queries over a dataset version, as jobs." },
  { key: "activity", label: "Activity", blurb: "Who did what, in this workspace." },
  { key: "ops", label: "Operations", blurb: "Classified failures and the jobs that need attention." },
  { key: "epistemic", label: "Ledger", blurb: "Bitemporal claims, beliefs and their provenance." },
  { key: "graph", label: "Graph", blurb: "A Cypher-queryable projection rebuilt from the ledger." },
  { key: "rag", label: "Retrieval", blurb: "Documents, hybrid search, immutable versions." },
  { key: "keys", label: "Keys", blurb: "Revoke a credential this principal minted." },
];

export interface CapabilityGroup {
  key: string;
  label: string;
  blurb: string;
  capabilities: CapabilityDescriptor[];
}

export function capabilityGroups(): CapabilityGroup[] {
  const byNoun = new Map<string, CapabilityDescriptor[]>();
  for (const capability of OCTO_CAPABILITIES) {
    const noun = capability.action.split(".")[0]!;
    const list = byNoun.get(noun) ?? [];
    list.push(capability);
    byNoun.set(noun, list);
  }
  return GROUPS.filter((group) => byNoun.has(group.key)).map((group) => ({
    ...group,
    capabilities: byNoun.get(group.key)!,
  }));
}

/** Actions that exist on the HTTP surface but are not capability-gated, so they
 *  never appear in `/api/capabilities`. Kept short and explicit. */
export const EXTRA_ROUTES: { method: "GET" | "POST" | "PATCH" | "DELETE" | "ANY"; path: string; scope: string; summary: string }[] = [
  {
    method: "GET",
    path: "/api/capabilities",
    scope: "any key",
    summary: "The catalogue itself: every action this key may invoke, already filtered.",
  },
  {
    method: "GET",
    path: "/health",
    scope: "none",
    summary: "Liveness, database and object-store status, analytics availability.",
  },
  {
    method: "POST",
    path: "/api/keys",
    scope: "session",
    summary: "Mint a key. Human-stamped: confirmation secret, plus TOTP when MFA is enrolled.",
  },
  {
    method: "GET",
    path: "/api/keys?workspaceId=<id>",
    scope: "any key",
    summary: "List the principal's keys, optionally for one workspace.",
  },
  {
    method: "PATCH",
    path: "/api/keys/<keyId>",
    scope: "session",
    summary: "Edit a key's allowances. The secret does not change.",
  },
  {
    method: "POST",
    path: "/api/workspaces/shares",
    scope: "write",
    summary: "Mint a gallery share link. Admin role; the raw token is returned once.",
  },
  {
    method: "GET",
    path: "/api/workspaces/shares?workspaceId=<id>",
    scope: "read",
    summary: "List a workspace's share links. Admin role.",
  },
  {
    method: "DELETE",
    path: "/api/shares/<id>?workspaceId=<id>",
    scope: "delete",
    summary: "Revoke a share link.",
  },
  {
    method: "GET",
    path: "/api/public/shares/<token>",
    scope: "none",
    summary: "The anonymous share view. Unknown, revoked and expired all answer the same 404.",
  },
  {
    method: "GET",
    path: "/api/files/content?workspaceId=<id>&fileId=<id>",
    scope: "files",
    summary: "The file's bytes, authenticated.",
  },
  {
    method: "GET",
    path: "/api/files/thumbnail?workspaceId=<id>&fileId=<id>",
    scope: "files",
    summary: "The cached small derivative, for a grid.",
  },
  {
    method: "POST",
    path: "/api/jobs/<jobId>/retry",
    scope: "write",
    summary: "Re-enqueue a failed job.",
  },
  {
    method: "GET",
    path: "/api/workspaces/<id>/analytics/results/<resultId>/rows?limit=500",
    scope: "read",
    summary: "A completed result as JSON rows, up to 500 at a time.",
  },
  {
    method: "GET",
    path: "/api/workspaces/<id>/analytics/results/<resultId>/content",
    scope: "read",
    summary: "The result artifact's Parquet bytes on a local storage backend.",
  },
  {
    method: "POST",
    path: "/api/rag/query",
    scope: "read",
    summary: "Hybrid lexical-plus-vector search over indexed documents.",
  },
  {
    method: "POST",
    path: "/mcp",
    scope: "any key / OAuth",
    summary: "The MCP endpoint, Streamable HTTP. The same actions as tools.",
  },
];
