-- Octo Schema: Slice 8 - RAG document lifecycle (rename, delete)
--
-- Slice 8 wrote the RAG tables and policies for a create-and-read surface: SELECT
-- (member) and INSERT (operator) only. The document catalog is now manageable
-- (list, get, rename, delete), so the two verbs those routes use need policies --
-- the same "policy completion" this repo already did for chunks/embeddings in
-- slice14. GRANT already covers UPDATE and DELETE; only the policies are missing.
--
-- Delete is a single `DELETE FROM octo.documents`, whose ON DELETE CASCADE removes
-- versions, then chunks and embeddings. Referential-integrity actions bypass row
-- security, so only octo.documents needs the DELETE policy; the child tables keep
-- their slice14 delete policies for the re-ingest path.

-- Rename: metadata-only. Operator+ can already ingest, so rename adds no authority
-- they lack. A key's effective role is the minimum of its key role and live role.
DROP POLICY IF EXISTS documents_update_operator ON octo.documents;
CREATE POLICY documents_update_operator ON octo.documents
    FOR UPDATE
    USING (octo.get_workspace_role(workspace_id) IN ('owner', 'admin', 'operator'))
    WITH CHECK (octo.get_workspace_role(workspace_id) IN ('owner', 'admin', 'operator'));

-- Delete: destructive, so owner/admin only -- the same bar as file deletion.
DROP POLICY IF EXISTS documents_delete_owner_admin ON octo.documents;
CREATE POLICY documents_delete_owner_admin ON octo.documents
    FOR DELETE
    USING (octo.get_workspace_role(workspace_id) IN ('owner', 'admin'));
