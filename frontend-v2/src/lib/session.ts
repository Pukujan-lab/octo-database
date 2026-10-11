/** Session storage + lifetime rules.
 *
 *  Only two keys are ever persisted: the bearer token (`octo_token`) and the
 *  cached principal (`octo_principal`, which also carries the session expiry and
 *  the idle timestamp). One-time secrets never touch storage. */

import type { Principal } from "./types";

export const TOKEN_KEY = "octo_token";
export const PRINCIPAL_KEY = "octo_principal";

/** The server issues 20-minute tokens and enforces a 20-minute idle timeout. */
export const SESSION_TTL_MS = 20 * 60 * 1000;
export const IDLE_TIMEOUT_MS = 20 * 60 * 1000;

export const SESSION_EXPIRED_EVENT = "octo:session-expired";

export type CachedSession = {
  expiresAt: number | null;
  lastActivityAt: number;
};

function readJson(raw: string | null): Record<string, unknown> {
  if (!raw) return {};
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return {};
  }
}

export function getToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function readCachedSession(): CachedSession | null {
  try {
    const raw = localStorage.getItem(PRINCIPAL_KEY);
    if (!raw) return null;
    const parsed = readJson(raw);
    return {
      expiresAt: typeof parsed.sessionExpiresAt === "number" ? parsed.sessionExpiresAt : null,
      lastActivityAt: typeof parsed.lastActivityAt === "number" ? parsed.lastActivityAt : Date.now(),
    };
  } catch {
    return null;
  }
}

/** The principal cached on the last successful /api/me, for a fast first paint. */
export function getCachedPrincipal(): Principal | null {
  try {
    const parsed = readJson(localStorage.getItem(PRINCIPAL_KEY));
    const principal = parsed.principal as Principal | undefined;
    return principal && typeof principal.id === "string" ? principal : null;
  } catch {
    return null;
  }
}

/** Absolute token expiry. A JWT's `exp` claim wins; otherwise fall back to the
 *  issuance timestamp recorded when the session was written. */
export function tokenExpiresAt(token: string, fallback: number | null): number | null {
  return jwtExpiry(token) ?? fallback;
}

function jwtExpiry(token: string): number | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const payload = JSON.parse(decodeBase64Url(parts[1])) as { exp?: number };
    if (typeof payload?.exp === "number") return payload.exp * 1000;
  } catch {
    return null;
  }
  return null;
}

function decodeBase64Url(value: string): string {
  const normal = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normal + "=".repeat((4 - (normal.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

/** Persist the session. Passing `null` for `expiresAt` keeps any expiry already
 *  on record, so refreshing the cached principal never extends the session. */
export function writeSession(token: string, principalCache: object, expiresAt: number | null) {
  const now = Date.now();
  const previous = readJson(localStorage.getItem(PRINCIPAL_KEY));
  const carried = typeof previous.sessionExpiresAt === "number" ? previous.sessionExpiresAt : null;
  localStorage.setItem(TOKEN_KEY, token);
  localStorage.setItem(
    PRINCIPAL_KEY,
    JSON.stringify({
      ...principalCache,
      sessionExpiresAt: expiresAt ?? carried ?? now + SESSION_TTL_MS,
      lastActivityAt: now,
    }),
  );
}

/** Record real user interaction so the idle timeout mirrors the server's. */
export function touchActivity() {
  try {
    const parsed = readJson(localStorage.getItem(PRINCIPAL_KEY));
    localStorage.setItem(PRINCIPAL_KEY, JSON.stringify({ ...parsed, lastActivityAt: Date.now() }));
  } catch {
    /* storage blocked — the session simply ends on its absolute expiry */
  }
}

export function clearSession() {
  try {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(PRINCIPAL_KEY);
  } catch {
    /* ignore */
  }
}

export function announceExpiry(reason: string) {
  window.dispatchEvent(new CustomEvent(SESSION_EXPIRED_EVENT, { detail: reason }));
}

/** Time left before the session must be re-established: whichever comes first,
 *  the absolute token expiry or 20 minutes of silence. */
export function sessionRemainingMs(absoluteExpiry: number | null, lastActivity: number): number {
  const idleExpiry = lastActivity + IDLE_TIMEOUT_MS;
  const candidates = [absoluteExpiry, idleExpiry].filter((value): value is number => typeof value === "number");
  if (!candidates.length) return IDLE_TIMEOUT_MS;
  return Math.max(0, Math.min(...candidates) - Date.now());
}
