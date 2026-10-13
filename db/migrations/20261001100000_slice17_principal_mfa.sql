-- Slice 17 — MFA (TOTP) step-up for destructive commands.
--
-- A per-principal MFA record: the TOTP secret (encrypted at rest with the
-- OCTO_MFA_SECRET key; never stored in plaintext, never hashed because it must
-- be recoverable to verify codes), when it was confirmed, and the hashes of the
-- one-time recovery codes.
--
-- These live on octo.principals beside confirm_secret_hash, which is the
-- directly comparable per-principal secret. They are read and written on the
-- trusted service path (like confirm_secret_hash), so no new RLS policy or
-- client-facing grant is required.
ALTER TABLE octo.principals ADD COLUMN IF NOT EXISTS mfa_secret_encrypted TEXT;
ALTER TABLE octo.principals ADD COLUMN IF NOT EXISTS mfa_confirmed_at TIMESTAMPTZ;
ALTER TABLE octo.principals ADD COLUMN IF NOT EXISTS mfa_recovery_code_hashes TEXT[] NOT NULL DEFAULT '{}';
