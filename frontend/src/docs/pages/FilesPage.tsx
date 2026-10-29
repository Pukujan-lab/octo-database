import { Link } from "react-router-dom";
import { Callout, C, CodeBlock, Exchange, H2, P, PageHeader, UL } from "@/docs/blocks";

const BASE = "https://octodb.design-bakery.com";

export function FilesPage() {
  return (
    <>
      <PageHeader
        eyebrow="Guide"
        title="Files and publishing"
        lead="Upload bytes into a workspace, serve them back, archive them cold, and publish a single one to a stable public URL."
      />

      <Callout title="Files scope, not read/write">
        Every file route requires the <C>files</C> scope. Uploading and publishing additionally
        require <C>write</C>; deleting requires <C>delete</C> and the admin role. A key without{" "}
        <C>files</C> cannot touch file bytes even if it can read workspace metadata.
      </Callout>

      <H2 id="upload">Upload</H2>
      <P>
        The body is JSON with the bytes base64-encoded, or plain UTF-8 text. A workspace-scoped
        key is fenced to its own workspace here too.
      </P>
      <Exchange
        request={{
          code: `POST /api/files/upload
Authorization: Bearer octo_live_ws_...

{
  "workspaceId": "6f1c2a90-...",
  "name": "cover.png",
  "mimeType": "image/png",
  "data": "<base64 bytes>",
  "dataEncoding": "base64"
}`,
        }}
        response={{
          code: `201 {
  "id": "b3d1...",
  "workspaceId": "6f1c2a90-...",
  "name": "cover.png",
  "mimeType": "image/png",
  "sizeBytes": 184320,
  "archiveState": "active",
  "publishedAt": null,
  "publishedUrl": null,
  "createdAt": "2026-10-28T09:14:02.118Z"
}`,
          caption: "`dataEncoding` accepts `base64` or `utf8`; omit it and the value is read as UTF-8.",
        }}
      />

      <H2 id="list-download">List and download</H2>
      <CodeBlock
        label="HTTP"
        code={`GET /api/files?workspaceId=<id>                          → FileRecord[]
GET /api/files/download?workspaceId=<id>&fileId=<id>     → short-lived download URL
GET /api/files/content?workspaceId=<id>&fileId=<id>      → the bytes
GET /api/files/thumbnail?workspaceId=<id>&fileId=<id>    → cached small derivative`}
      />
      <P>
        Listing returns only active files. A download URL is short-lived, so fetch it immediately
        before use rather than storing it.
      </P>

      <H2 id="publish">Publish one file</H2>
      <P>
        Publishing copies exactly one active file into the public bucket and returns its stable
        HTTPS URL. Nothing else in the workspace becomes reachable — no sibling file, no listing,
        no admin route.
      </P>
      <Exchange
        request={{
          code: `POST /api/files/<fileId>/publish?workspaceId=<id>
Authorization: Bearer octo_live_ws_...`,
        }}
        response={{
          code: `200 {
  "fileId": "b3d1...",
  "url": "https://cdn.example/octo-public/...",
  "publishedAt": "2026-10-28T09:20:11.004Z",
  "republished": false
}`,
          caption: "Republishing an already-published file refreshes the copy and reports `republished: true`.",
        }}
      />
      <P>
        Unpublishing removes the public URL and leaves the private file in the workspace, so the
        project never loses its copy:
      </P>
      <CodeBlock
        label="HTTP"
        code={`POST /api/files/<fileId>/unpublish?workspaceId=<id>`}
      />

      <H2 id="archive">Archive and restore</H2>
      <P>
        Archiving moves a file's bytes out of active storage into the cold archive. The record
        stays, and the bytes are restored on demand the next time something reads them.
      </P>
      <UL>
        <li>
          <C>POST /api/files/&lt;fileId&gt;/archive</C> — requires <C>delete</C> scope.
        </li>
        <li>
          <C>POST /api/files/&lt;fileId&gt;/restore</C> — requires <C>write</C> scope.
        </li>
      </UL>

      <H2 id="delete">Delete</H2>
      <P>
        <C>DELETE /api/files/&lt;fileId&gt;?workspaceId=&lt;id&gt;</C> requires the{" "}
        <C>delete</C> scope and the admin role. It is destructive and permanent: the record and the
        bytes both go. Archive instead if you may want the file back.
      </P>

      <H2 id="shares">Share links</H2>
      <P>
        A share link is a read-only (or upload-only) view of a workspace's gallery for someone with
        no Octo account. Minting one needs <C>write</C> scope and the admin role.
      </P>
      <Exchange
        request={{
          code: `POST /api/workspaces/shares
Authorization: Bearer octo_live_ws_...

{
  "workspaceId": "6f1c2a90-...",
  "resourceType": "gallery",
  "permission": "read",
  "expiresInHours": 72
}`,
        }}
        response={{
          code: `201 {
  "share": { "id": "...", "permission": "read", "expiresAt": "..." },
  "shareUrl": "/share/octo_share_...",
  "rawToken": "octo_share_..."
}`,
          caption: "The raw token is returned once and never persisted in plaintext. Revoke with `DELETE /api/shares/<id>`.",
        }}
      />
      <P>
        The anonymous view is <C>GET /api/public/shares/&lt;token&gt;</C>. Unknown, revoked,
        not-yet-valid and expired links all answer the same 404, so a token cannot be used to probe
        which links ever existed.
      </P>

      <P>
        Next:{" "}
        <Link className="text-primary underline underline-offset-2" to="/docs/analytics">
          analytics
        </Link>{" "}
        over immutable Parquet versions.
      </P>
    </>
  );
}
