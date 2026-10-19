import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, errorMessage } from "@/lib/api";
import {
  IDLE_TIMEOUT_MS,
  SESSION_EXPIRED_EVENT,
  SESSION_TTL_MS,
  clearSession,
  getCachedPrincipal,
  getToken,
  readCachedSession,
  sessionRemainingMs,
  touchActivity,
  tokenExpiresAt,
  writeSession,
} from "@/lib/session";
import type { MeResponse, Principal } from "@/lib/types";

const OAUTH_RETURN_KEY = "octo_oauth_return";
const ACTIVITY_EVENTS = ["click", "keydown", "pointerdown", "scroll", "touchstart"] as const;

export type SessionStatus = "signed-out" | "signed-in" | "restoring";

function readHashState(): { token: string | null; authError: string | null; oauthReturn: string | null } {
  const raw = window.location.hash.replace(/^#/, "");
  if (!raw) return { token: null, authError: null, oauthReturn: null };
  const params = new URLSearchParams(raw);
  return {
    token: params.get("token"),
    authError: params.get("auth_error"),
    oauthReturn: params.get("oauth_return"),
  };
}

function stripHash() {
  window.history.replaceState(null, "", window.location.pathname + window.location.search);
}

/** A connector bounce is only resumable when it points at our own origin's
 *  /oauth/authorize endpoint — anything else is discarded. */
function isSafeAuthorizeUrl(value: string): boolean {
  try {
    const url = new URL(value, window.location.origin);
    return url.origin === window.location.origin && url.pathname === "/oauth/authorize";
  } catch {
    return false;
  }
}

const AUTH_ERROR_COPY: Record<string, string> = {
  access_denied: "Google sign-in was cancelled. Please try again.",
  invalid_state: "That Google sign-in link expired. Please try again.",
  GOOGLE_AUTH_NOT_CONFIGURED: "Google sign-in is not configured on this server.",
  TOKEN_EXCHANGE_FAILED:
    "Google accepted the sign-in but the server could not complete the exchange. Please try again.",
  MISSING_PROFILE: "Google did not return an email address for this account.",
  MISSING_CODE: "Google returned without an authorization code. Please try again.",
};

export function useSession() {
  const queryClient = useQueryClient();
  const [token, setToken] = useState<string | null>(null);
  const [cachedPrincipal, setCachedPrincipal] = useState<Principal | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [signingIn, setSigningIn] = useState(false);
  const [remainingMs, setRemainingMs] = useState(IDLE_TIMEOUT_MS);
  const lastActivity = useRef<number>(Date.now());
  const absoluteExpiry = useRef<number | null>(null);
  const bootstrapped = useRef(false);

  /* ---------------------------------------------------------- bootstrap once */
  useEffect(() => {
    if (bootstrapped.current) return;
    bootstrapped.current = true;

    const hash = readHashState();

    // A connector bounce: stash the authorize URL (a Google round trip is a full
    // page navigation that would drop the hash), strip it, then carry on so the
    // dance can resume as soon as a session exists.
    if (hash.oauthReturn) {
      if (isSafeAuthorizeUrl(hash.oauthReturn)) {
        try {
          localStorage.setItem(OAUTH_RETURN_KEY, hash.oauthReturn);
        } catch {
          /* storage blocked — the dance simply will not resume */
        }
      }
      stripHash();
    }

    if (hash.token) {
      const expiresAt = Date.now() + SESSION_TTL_MS;
      writeSession(hash.token, {}, expiresAt);
      absoluteExpiry.current = tokenExpiresAt(hash.token, expiresAt);
      lastActivity.current = Date.now();
      setToken(hash.token);
      setCachedPrincipal(getCachedPrincipal());
      stripHash(); // never leave the token in the address bar
      return;
    }

    if (hash.authError) {
      stripHash();
      const known = AUTH_ERROR_COPY[hash.authError];
      setNotice(known ?? `Sign-in failed (${hash.authError}). Please try again.`);
      return;
    }

    const stored = getToken();
    if (stored) {
      const cached = readCachedSession();
      const expiry = tokenExpiresAt(stored, cached?.expiresAt ?? null);
      lastActivity.current = cached?.lastActivityAt ?? Date.now();
      if (sessionRemainingMs(expiry, lastActivity.current) > 0) {
        absoluteExpiry.current = expiry;
        setToken(stored);
        setCachedPrincipal(getCachedPrincipal()); // fast first paint while /api/me is in flight
      } else {
        clearSession();
        setNotice("Your session expired. Please sign in again.");
      }
    }
  }, []);

  /* ------------------------------------------------------------- identity */
  const meQuery = useQuery({
    queryKey: ["me", token],
    enabled: Boolean(token),
    staleTime: 30 * 1000,
    queryFn: () => api.get<MeResponse>("/api/me"),
  });

  useEffect(() => {
    if (!token || !meQuery.data?.principal) return;
    writeSession(token, { principal: meQuery.data.principal }, absoluteExpiry.current);
  }, [meQuery.data, token]);

  /* --------------------------------------------------- idle + expiry clock */
  const expire = useCallback(
    (reason: string) => {
      clearSession();
      absoluteExpiry.current = null;
      setToken(null);
      setCachedPrincipal(null);
      setNotice(reason);
      queryClient.clear();
    },
    [queryClient],
  );

  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<string>).detail;
      expire(detail || "Your session expired. Please sign in again.");
    };
    window.addEventListener(SESSION_EXPIRED_EVENT, handler);
    return () => window.removeEventListener(SESSION_EXPIRED_EVENT, handler);
  }, [expire]);

  useEffect(() => {
    if (!token) return;
    let throttle = 0;
    const onActivity = () => {
      const now = Date.now();
      if (now - throttle < 2000) return;
      throttle = now;
      lastActivity.current = now;
      touchActivity();
    };
    ACTIVITY_EVENTS.forEach((type) => window.addEventListener(type, onActivity, { passive: true }));
    return () => ACTIVITY_EVENTS.forEach((type) => window.removeEventListener(type, onActivity));
  }, [token]);

  useEffect(() => {
    if (!token) return;
    const tick = () => {
      const left = sessionRemainingMs(absoluteExpiry.current, lastActivity.current);
      setRemainingMs(left);
      if (left <= 0) expire("Your session expired. Please sign in again.");
    };
    tick();
    const timer = window.setInterval(tick, 30_000);
    return () => window.clearInterval(timer);
  }, [token, expire]);

  /* -------------------------------------------------- resume OAuth connector */
  const [dancing, setDancing] = useState(false);
  useEffect(() => {
    if (!token || !meQuery.data?.principal || dancing) return;
    let stashed: string | null = null;
    try {
      stashed = localStorage.getItem(OAUTH_RETURN_KEY);
    } catch {
      stashed = null;
    }
    if (!stashed) return;
    if (!isSafeAuthorizeUrl(stashed)) {
      try {
        localStorage.removeItem(OAUTH_RETURN_KEY);
      } catch {
        /* ignore */
      }
      return;
    }
    setDancing(true);
    void (async () => {
      try {
        // Hand the authorization server the same session as a short-lived HttpOnly cookie.
        await api.post("/oauth/dance", {});
      } catch {
        /* proceed — the authorize screen re-prompts if the cookie is missing */
      }
      try {
        localStorage.removeItem(OAUTH_RETURN_KEY);
      } catch {
        /* ignore */
      }
      window.location.replace(stashed as string);
    })();
  }, [token, meQuery.data, dancing]);

  /* --------------------------------------------------------------- actions */
  const signInWithGuest = useCallback(async (input: { displayName?: string; turnstileToken?: string }) => {
    setSigningIn(true);
    try {
      const result = await api.post<{ principal: Principal; sessionToken: string }>(
        "/api/auth/guest",
        {
          displayName: input.displayName || undefined,
          turnstileToken: input.turnstileToken || undefined,
        },
        { authMode: "public", endSessionOn401: false },
      );
      const expiresAt = Date.now() + SESSION_TTL_MS;
      writeSession(result.sessionToken, { principal: result.principal }, expiresAt);
      absoluteExpiry.current = tokenExpiresAt(result.sessionToken, expiresAt);
      lastActivity.current = Date.now();
      touchActivity();
      setNotice(null);
      setCachedPrincipal(result.principal);
      setToken(result.sessionToken);
      return true;
    } catch (error) {
      setNotice(errorMessage(error));
      return false;
    } finally {
      setSigningIn(false);
    }
  }, []);

  const signOut = useCallback(() => expire("Signed out. Sign in again to continue."), [expire]);

  const principal = meQuery.data?.principal ?? cachedPrincipal;
  const status: SessionStatus = token ? (meQuery.data || cachedPrincipal ? "signed-in" : "restoring") : "signed-out";

  return useMemo(
    () => ({
      status,
      token,
      principal,
      me: meQuery.data ?? null,
      meError: meQuery.error ? errorMessage(meQuery.error) : null,
      notice,
      setNotice,
      signingIn,
      signInWithGuest,
      signOut,
      remainingMs,
      refreshMe: () => meQuery.refetch(),
    }),
    [status, token, principal, meQuery.data, meQuery.error, notice, signingIn, signInWithGuest, signOut, remainingMs, meQuery],
  );
}

export type Session = ReturnType<typeof useSession>;
