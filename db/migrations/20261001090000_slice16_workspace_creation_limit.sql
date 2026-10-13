-- Slice 16 — workspace-creation daily limit.
--
-- The limit counts workspaces a principal created *through the API* in a rolling
-- day. The personal sandbox handed to a principal at sign-in must not consume
-- that quota, or a brand-new account could not create its first project
-- workspace (it already owns the auto-provisioned one). `auto_provisioned` marks
-- those sign-in sandboxes; every workspace a principal creates via
-- POST /api/workspaces defaults to false and therefore counts.
ALTER TABLE octo.workspaces ADD COLUMN IF NOT EXISTS auto_provisioned BOOLEAN NOT NULL DEFAULT false;
