/**
 * The current principal: profile, confirmation secret, and MFA enrolment.
 *
 * One route family, dispatched by src/server/index.ts. Returns true when this
 * family handled the request.
 */

import { hashApiKeySecret } from '../api/keys';
import { issueConfirmChallenge } from '../auth/confirm-challenge';
import { decryptSecret, encryptSecret, generateRecoveryCodes, generateTotpSecret, hashRecoveryCode, totpProvisioningUri, verifyTotpCode } from '../lib/mfa';
import { authenticateRequest } from '../server/auth-context';
import { verifyMfaCode } from '../server/confirm';
import { dbClearMfa, dbConfirmMfa, dbGetConfirmSecretHash, dbGetMfa, dbSetConfirmSecret, dbSetMfaPending, dbSetMfaRecoveryCodes } from '../server/db';
import { readJsonObject, sendJson } from '../server/http';
import { IncomingMessage, ServerResponse } from 'http';

export async function handleMeRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL
): Promise<boolean> {
  const pathname = url.pathname;

  // 2b. Current Principal: GET /api/me
  if (pathname === '/api/me' && req.method === 'GET') {
    const auth = await authenticateRequest(req);
    if (!auth) {
      sendJson(res, 401, { error: 'UNAUTHENTICATED' });
      return true;
    }
    // The client needs to know whether the destructive-command gate is armed so
    // it can prompt for setup rather than letting the user hit a 412, and whether
    // MFA is enrolled so it can prompt for a code.
    const confirmSecretSet = Boolean(await dbGetConfirmSecretHash(auth.principal.id));
    const mfa = await dbGetMfa(auth.principal.id);
    sendJson(res, 200, {
      principal: auth.principal,
      apiKey: auth.apiKey ?? null,
      confirmSecretSet,
      mfaEnabled: Boolean(mfa?.confirmedAt),
      mfaRecoveryCodesRemaining: mfa?.recoveryCodeHashes.length ?? 0,
    });
    return true;
  }

  // 2c. Set or rotate the confirmation secret: POST /api/me/confirm-secret
  // Human session only. Rotation is itself destructive, so changing an existing
  // secret requires presenting the current one; first-time setup does not.
  if (pathname === '/api/me/confirm-secret' && req.method === 'POST') {
    const auth = await authenticateRequest(req);
    if (!auth) {
      sendJson(res, 401, { error: 'UNAUTHENTICATED' });
      return true;
    }
    if (auth.apiKey) {
      sendJson(res, 403, {
        error: 'FORBIDDEN: The confirmation secret is set from a human session, never an API key.',
      });
      return true;
    }

    const parsed = await readJsonObject(req);
    const { secret, currentSecret } = parsed;
    if (typeof secret !== 'string' || secret.length < 8) {
      sendJson(res, 400, { error: 'BAD_REQUEST: secret must be a string of at least 8 characters' });
      return true;
    }

    const existing = await dbGetConfirmSecretHash(auth.principal.id);
    if (existing) {
      if (typeof currentSecret !== 'string' || hashApiKeySecret(currentSecret) !== existing) {
        sendJson(res, 403, {
          error: 'CONFIRM_SECRET_INVALID: the current confirmation secret is required to rotate it.',
        });
        return true;
      }
    }

    await dbSetConfirmSecret(auth.principal.id, hashApiKeySecret(secret));
    sendJson(res, 200, { success: true, rotated: Boolean(existing) });
    return true;
  }

  // A one-time code shown on the form. The human types it back. Nothing is
  // remembered between actions. An API key cannot ask for one.
  if (pathname === '/api/me/confirm-challenge' && req.method === 'POST') {
    const auth = await authenticateRequest(req);
    if (!auth) {
      sendJson(res, 401, { error: 'UNAUTHENTICATED' });
      return true;
    }
    if (auth.apiKey) {
      sendJson(res, 403, {
        error: 'FORBIDDEN: A confirmation code is issued to a human session, never an API key.',
      });
      return true;
    }
    sendJson(res, 200, issueConfirmChallenge(auth.principal.id));
    return true;
  }

  // 2d. MFA (TOTP) status. Human session only, like the confirmation secret:
  // MFA protects a person's own account, never an agent's.
  if (pathname === '/api/me/mfa' && req.method === 'GET') {
    const auth = await authenticateRequest(req);
    if (!auth) {
      sendJson(res, 401, { error: 'UNAUTHENTICATED' });
      return true;
    }
    if (auth.apiKey) {
      sendJson(res, 403, { error: 'FORBIDDEN: MFA is managed from a human session, never an API key.' });
      return true;
    }
    const mfa = await dbGetMfa(auth.principal.id);
    sendJson(res, 200, {
      enabled: Boolean(mfa?.confirmedAt),
      confirmedAt: mfa?.confirmedAt ?? null,
      recoveryCodesRemaining: mfa?.recoveryCodeHashes.length ?? 0,
    });
    return true;
  }

  // 2e. Begin MFA enrollment: mint a secret and return its provisioning URI
  // once. The secret is stored encrypted and unconfirmed until a code proves it.
  if (pathname === '/api/me/mfa/begin' && req.method === 'POST') {
    const auth = await authenticateRequest(req);
    if (!auth) {
      sendJson(res, 401, { error: 'UNAUTHENTICATED' });
      return true;
    }
    if (auth.apiKey) {
      sendJson(res, 403, { error: 'FORBIDDEN: MFA is managed from a human session, never an API key.' });
      return true;
    }
    const existing = await dbGetMfa(auth.principal.id);
    if (existing?.confirmedAt) {
      sendJson(res, 409, { error: 'MFA_ALREADY_ENABLED: Disable MFA before enrolling a new authenticator.' });
      return true;
    }
    const secret = generateTotpSecret();
    let encrypted: string;
    try {
      encrypted = encryptSecret(secret);
    } catch {
      sendJson(res, 503, {
        error: 'MFA_NOT_CONFIGURED: MFA enrollment requires OCTO_MFA_SECRET on the server.',
      });
      return true;
    }
    await dbSetMfaPending(auth.principal.id, encrypted);
    const label = auth.principal.email || auth.principal.displayName || auth.principal.id;
    sendJson(res, 200, { secret, otpauthUri: totpProvisioningUri(secret, label) });
    return true;
  }

  // 2f. Confirm MFA enrollment with a code from the authenticator. Issues the
  // one-time recovery codes exactly here.
  if (pathname === '/api/me/mfa/confirm' && req.method === 'POST') {
    const auth = await authenticateRequest(req);
    if (!auth) {
      sendJson(res, 401, { error: 'UNAUTHENTICATED' });
      return true;
    }
    if (auth.apiKey) {
      sendJson(res, 403, { error: 'FORBIDDEN: MFA is managed from a human session, never an API key.' });
      return true;
    }
    const parsed = await readJsonObject(req);
    const mfa = await dbGetMfa(auth.principal.id);
    if (!mfa) {
      sendJson(res, 400, { error: 'MFA_NOT_STARTED: Begin enrollment before confirming it.' });
      return true;
    }
    if (mfa.confirmedAt) {
      sendJson(res, 409, { error: 'MFA_ALREADY_ENABLED: MFA is already enabled.' });
      return true;
    }
    let secret: string;
    try {
      secret = decryptSecret(mfa.secretEncrypted);
    } catch {
      sendJson(res, 500, { error: 'MFA_SECRET_UNREADABLE: Re-enroll the authenticator.' });
      return true;
    }
    if (!verifyTotpCode(secret, parsed.code)) {
      sendJson(res, 403, { error: 'MFA_CODE_INVALID: That code did not match. Try the next one.' });
      return true;
    }
    const recoveryCodes = generateRecoveryCodes();
    await dbConfirmMfa(auth.principal.id, recoveryCodes.map(hashRecoveryCode));
    sendJson(res, 200, { recoveryCodes });
    return true;
  }

  // 2g. Disable MFA. Requires a valid current code or a one-time recovery code
  // (the recovery path), so a lost authenticator does not lock the account out.
  if (pathname === '/api/me/mfa/disable' && req.method === 'POST') {
    const auth = await authenticateRequest(req);
    if (!auth) {
      sendJson(res, 401, { error: 'UNAUTHENTICATED' });
      return true;
    }
    if (auth.apiKey) {
      sendJson(res, 403, { error: 'FORBIDDEN: MFA is managed from a human session, never an API key.' });
      return true;
    }
    const parsed = await readJsonObject(req);
    const mfa = await dbGetMfa(auth.principal.id);
    if (!mfa?.confirmedAt) {
      sendJson(res, 409, { error: 'MFA_NOT_ENABLED: MFA is not enabled.' });
      return true;
    }
    if (!(await verifyMfaCode(auth.principal.id, mfa, parsed.code))) {
      sendJson(res, 403, { error: 'MFA_CODE_INVALID: Enter a current authenticator code or a recovery code.' });
      return true;
    }
    await dbClearMfa(auth.principal.id);
    sendJson(res, 200, { disabled: true });
    return true;
  }

  // 2h. Rotate recovery codes. Requires a current authenticator code (not a
  // recovery code), and returns the new set once.
  if (pathname === '/api/me/mfa/recovery-codes' && req.method === 'POST') {
    const auth = await authenticateRequest(req);
    if (!auth) {
      sendJson(res, 401, { error: 'UNAUTHENTICATED' });
      return true;
    }
    if (auth.apiKey) {
      sendJson(res, 403, { error: 'FORBIDDEN: MFA is managed from a human session, never an API key.' });
      return true;
    }
    const parsed = await readJsonObject(req);
    const mfa = await dbGetMfa(auth.principal.id);
    if (!mfa?.confirmedAt) {
      sendJson(res, 409, { error: 'MFA_NOT_ENABLED: MFA is not enabled.' });
      return true;
    }
    let secret: string;
    try {
      secret = decryptSecret(mfa.secretEncrypted);
    } catch {
      sendJson(res, 500, { error: 'MFA_SECRET_UNREADABLE: Re-enroll the authenticator.' });
      return true;
    }
    if (!verifyTotpCode(secret, parsed.code)) {
      sendJson(res, 403, { error: 'MFA_CODE_INVALID: A current authenticator code is required to rotate recovery codes.' });
      return true;
    }
    const recoveryCodes = generateRecoveryCodes();
    await dbSetMfaRecoveryCodes(auth.principal.id, recoveryCodes.map(hashRecoveryCode));
    sendJson(res, 200, { recoveryCodes });
    return true;
  }

  return false;
}
