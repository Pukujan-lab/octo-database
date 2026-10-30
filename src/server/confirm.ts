/**
 * The human confirmation gate for destructive commands, including the optional
 * MFA step-up.
 */

import { hashApiKeySecret } from '../api/keys';
import {
  acceptConfirmChallenge,
  hasConfirmChallenge,
  inConfirmWindow,
  issueConfirmChallenge,
  openConfirmWindow,
} from '../auth/confirm-challenge';
import { decryptSecret, hashRecoveryCode, verifyTotpCode } from '../lib/mfa';
import { AuthContext } from './auth-context';
import { dbConsumeMfaRecoveryCode, dbGetConfirmSecretHash, dbGetMfa, MfaRecord } from './db';
import { sendJson } from './http';
import { ServerResponse } from 'http';

/**
 * The human confirmation gate for destructive commands. It is satisfied only when
 * both hold: the caller is a human session (no API key), and the supplied value
 * is the one-time code just shown to that person (or, for existing API clients,
 * the stored confirmation secret). An API-key caller can never satisfy it,
 * whatever its scopes -- that is the structural answer to "can a blind agent
 * delete a workspace".
 *
 * When `options.requireMfa` is set and the principal has confirmed MFA, a valid
 * TOTP code (or a one-time recovery code) is additionally required. A used
 * recovery code is consumed. Principals without MFA enrolled are unaffected.
 *
 * An account that never set a secret is gated by the one-time code alone; when
 * no live code exists (the server restarted since it was shown) a fresh one is
 * issued instead of demanding setup the person did not ask for. Returns true
 * when the request may proceed, having already written the refusal response
 * otherwise.
 *
 * Passing the full gate opens a two-minute window in which the same person's
 * further gated actions need no codes.
 */
export async function confirmGate(
  res: ServerResponse,
  auth: AuthContext,
  suppliedSecret: unknown,
  options: { requireMfa?: boolean; mfaCode?: unknown } = {}
): Promise<boolean> {
  if (auth.apiKey) {
    sendJson(res, 403, {
      error: 'FORBIDDEN: Destructive commands require a human session; API keys can never confirm.',
    });
    return false;
  }

  // Codes that are sent are always checked; only a request that sends none uses the window.
  if (!hasValue(suppliedSecret) && !hasValue(options.mfaCode) && inConfirmWindow(auth.principal.id)) return true;

  const passed = await checkCodes(res, auth, suppliedSecret, options);
  if (passed) openConfirmWindow(auth.principal.id);
  return passed;
}

function hasValue(value: unknown): boolean {
  return typeof value === 'string' ? value.trim() !== '' : value !== undefined && value !== null;
}

async function checkCodes(
  res: ServerResponse,
  auth: AuthContext,
  suppliedSecret: unknown,
  options: { requireMfa?: boolean; mfaCode?: unknown }
): Promise<boolean> {
  if (acceptConfirmChallenge(auth.principal.id, suppliedSecret)) {
    return confirmMfa(res, auth, options);
  }

  if (hasConfirmChallenge(auth.principal.id)) {
    sendJson(res, 403, { error: 'CONFIRM_CODE_INVALID: Type the code shown on the form.' });
    return false;
  }

  const stored = await dbGetConfirmSecretHash(auth.principal.id);
  if (!stored) {
    // Pending codes live in memory, so a restart drops the one on screen. Issue
    // a new one and let the client re-read it rather than dead-ending on setup.
    issueConfirmChallenge(auth.principal.id);
    sendJson(res, 403, {
      error: 'CONFIRM_CODE_INVALID: That code expired. Type the new code shown on the form.',
    });
    return false;
  }

  if (typeof suppliedSecret !== 'string' || hashApiKeySecret(suppliedSecret) !== stored) {
    sendJson(res, 403, { error: 'CONFIRM_SECRET_INVALID: Confirmation secret does not match.' });
    return false;
  }

  return confirmMfa(res, auth, options);
}

export async function confirmMfa(
  res: ServerResponse,
  auth: AuthContext,
  options: { requireMfa?: boolean; mfaCode?: unknown }
): Promise<boolean> {
  if (options.requireMfa) {
    const mfa = await dbGetMfa(auth.principal.id);
    if (mfa?.confirmedAt) {
      const ok = await verifyMfaCode(auth.principal.id, mfa, options.mfaCode);
      if (!ok) {
        sendJson(res, 403, {
          error: 'MFA_CODE_INVALID: A valid authenticator code is required to complete this command.',
        });
        return false;
      }
    }
  }
  return true;
}

/**
 * Verifies a TOTP code against the enrolled secret, falling back to a one-time
 * recovery code (which is consumed on success). Returns false for a missing or
 * malformed code.
 */
export async function verifyMfaCode(principalId: string, mfa: MfaRecord, supplied: unknown): Promise<boolean> {
  if (typeof supplied !== 'string' || !supplied.trim()) return false;
  let secret: string;
  try {
    secret = decryptSecret(mfa.secretEncrypted);
  } catch {
    // A key rotation or corrupt record must fail closed, not fall open.
    return false;
  }
  if (verifyTotpCode(secret, supplied)) return true;

  // Recovery codes are one-time. Consume atomically so two concurrent step-ups
  // presenting the same code cannot both succeed.
  return dbConsumeMfaRecoveryCode(principalId, hashRecoveryCode(supplied));
}
