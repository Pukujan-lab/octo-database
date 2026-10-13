/**
 * Per-principal TOTP (RFC 6238) step-up for the destructive-command gate.
 *
 * The TOTP secret is encrypted at rest with a key derived from OCTO_MFA_SECRET.
 * It cannot be hashed like the confirmation secret because verifying a code
 * requires the original secret; the AES-256-GCM envelope keeps it out of a
 * plaintext database read while reusing the platform's normal env-injected
 * secret mechanism (no new secret-management system).
 */

import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { generateSecret, generateURI, verifySync } from 'otplib/functional';
import { hashApiKeySecret } from './secret-hash';

const ISSUER = 'Octo';

/**
 * Tolerance in seconds around the current time step. 30s = +/- one 30-second
 * step, which absorbs the normal clock drift of an authenticator app without
 * materially widening the replay window.
 */
const TOTP_EPOCH_TOLERANCE_SECONDS = 30;

const RECOVERY_CODE_COUNT = 10;

export function generateTotpSecret(): string {
  return generateSecret();
}

/** The otpauth:// URI an authenticator app scans. */
export function totpProvisioningUri(secret: string, accountLabel: string): string {
  return generateURI({ issuer: ISSUER, label: accountLabel, secret });
}

/** True when `token` is the current (or adjacent) 6-digit code for `secret`. */
export function verifyTotpCode(secret: string, token: unknown): boolean {
  if (typeof token !== 'string') return false;
  const trimmed = token.trim();
  if (!/^\d{6}$/.test(trimmed)) return false;
  try {
    return verifySync({ secret, token: trimmed, epochTolerance: TOTP_EPOCH_TOLERANCE_SECONDS }).valid === true;
  } catch {
    // A malformed stored secret or plugin error must fail closed, not throw into
    // the request path.
    return false;
  }
}

export function generateRecoveryCodes(count = RECOVERY_CODE_COUNT): string[] {
  return Array.from({ length: count }, () => randomBytes(5).toString('hex'));
}

/** Recovery codes are high-entropy, so a plain hash (as for API keys) suffices. */
export function hashRecoveryCode(code: string): string {
  return hashApiKeySecret(code.trim().toLowerCase());
}

function encryptionKey(): Buffer {
  const secret = process.env['OCTO_MFA_SECRET'];
  if (!secret) {
    throw new Error('MFA_NOT_CONFIGURED: OCTO_MFA_SECRET is required to enroll MFA.');
  }
  return createHash('sha256').update(secret).digest();
}

/** Encrypts a TOTP secret as `iv.tag.ciphertext`, all base64. */
export function encryptSecret(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv.toString('base64'), tag.toString('base64'), ciphertext.toString('base64')].join('.');
}

export function decryptSecret(blob: string): string {
  const [iv, tag, ciphertext] = blob.split('.');
  if (!iv || !tag || !ciphertext) throw new Error('MFA_SECRET_MALFORMED');
  const decipher = createDecipheriv('aes-256-gcm', encryptionKey(), Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([
    decipher.update(Buffer.from(ciphertext, 'base64')),
    decipher.final(),
  ]).toString('utf8');
}
