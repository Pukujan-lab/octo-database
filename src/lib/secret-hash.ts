import { createHash } from 'node:crypto';

/**
 * Computes a SHA-256 hash of a raw API key secret.
 */
export function hashApiKeySecret(secret: string): string {
  return createHash('sha256').update(secret).digest('hex');
}
