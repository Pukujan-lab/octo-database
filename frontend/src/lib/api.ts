import { announceExpiry, clearSession, getToken } from "./session";

export class ApiError extends Error {
  status: number;
  code?: string;

  constructor(message: string, status: number, code?: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

/** The code the server answers with when the account has no confirmation secret. */
export const CONFIRM_SECRET_NOT_SET = "CONFIRM_SECRET_NOT_SET";

/** Machine codes the API returns are turned into sentences at the boundary, so
 *  every surface shows a useful message rather than a raw constant. */
const FRIENDLY: Record<string, string> = {
  TURNSTILE_FAILED: "Human verification failed. Complete the challenge and try again.",
  CONFIRM_SECRET_NOT_SET: "Set a confirmation secret first — it gates destructive actions.",
  ACCOUNT_KEY_EXISTS: "An account-wide key already exists for this account.",
  SLUG_TAKEN: "That workspace slug is already taken.",
  WORKSPACE_DAILY_LIMIT: "This account has used its workspace allowance for today.",
  SHARE_NOT_FOUND_OR_INACTIVE: "This share link is not available.",
  GOOGLE_AUTH_NOT_CONFIGURED: "Google sign-in is not configured on this server.",
  JOB_TYPE_RESERVED: "That job type is reserved — use the archive or restore action instead.",
  SESSION_EXPIRED: "Your session expired. Please sign in again.",
  VAULT_NOT_CONFIGURED: "The vault envelope key is not set on this server.",
  GRANT_HOURS: "Pick a lifetime from 5 hours through 3 days.",
  LABEL_REQUIRED: "Name the key.",
  DESCRIPTION_REQUIRED: "Add a description so an agent can tell this item apart.",
  ITEM_EMPTY: "Add a secret, a username, or a note.",
  NAME_REQUIRED: "Name the grant.",
};

type RequestOptions = {
  method?: string;
  body?: unknown;
  /** `public` calls (the share viewer) send no bearer token and never end the session. */
  authMode?: "session" | "public";
  /** Auth endpoints answer 401 legitimately — they must not sign the user out. */
  endSessionOn401?: boolean;
};

export function authHeaders(): HeadersInit {
  const token = getToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

export function qs(params: Record<string, string | number | undefined | null>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === "") continue;
    search.set(key, String(value));
  }
  const out = search.toString();
  return out ? `?${out}` : "";
}

async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const mode = options.authMode ?? "session";
  const headers: HeadersInit = {
    ...(mode === "session" ? authHeaders() : {}),
    ...(options.body !== undefined ? { "Content-Type": "application/json" } : {}),
  };

  let res: Response;
  try {
    res = await fetch(path, {
      method: options.method ?? "GET",
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
  } catch {
    throw new ApiError("Cannot reach the Octo API. Check that this app is served same-origin.", 0);
  }

  if (res.status === 401 && mode === "session" && options.endSessionOn401 !== false) {
    clearSession();
    announceExpiry("Your session expired. Please sign in again.");
    throw new ApiError("Session expired", 401, "SESSION_EXPIRED");
  }

  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    // The server answers with "MACHINE_CODE: human sentence" (or a bare code).
    // Split off the code so FRIENDLY lookups and errorCode() comparisons match.
    const raw = body.error ?? res.statusText;
    const sep = raw.indexOf(":");
    const code = sep === -1 ? raw : raw.slice(0, sep);
    throw new ApiError(FRIENDLY[code] ?? raw, res.status, code);
  }

  if (res.status === 204) return undefined as T;
  const text = await res.text();
  if (!text) return undefined as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new ApiError("Unexpected non-JSON response from the Octo API", res.status);
  }
}

export const api = {
  get: <T,>(path: string, options?: RequestOptions) => request<T>(path, { ...options, method: "GET" }),
  post: <T,>(path: string, body?: unknown, options?: RequestOptions) =>
    request<T>(path, { ...options, method: "POST", body }),
  patch: <T,>(path: string, body?: unknown, options?: RequestOptions) =>
    request<T>(path, { ...options, method: "PATCH", body }),
  del: <T,>(path: string, body?: unknown, options?: RequestOptions) =>
    request<T>(path, { ...options, method: "DELETE", body }),
};

/** Raw bytes for an authenticated file download. */
export async function fetchBlob(path: string): Promise<Blob> {
  const res = await fetch(path, { headers: authHeaders() });
  if (res.status === 401) {
    clearSession();
    announceExpiry("Your session expired. Please sign in again.");
    throw new ApiError("Session expired", 401, "SESSION_EXPIRED");
  }
  if (!res.ok) throw new ApiError(`Download failed (${res.status})`, res.status);
  return res.blob();
}

export function isConfirmSecretMissing(error: unknown): boolean {
  return error instanceof ApiError && error.code === CONFIRM_SECRET_NOT_SET;
}

export function errorCode(error: unknown): string | undefined {
  return error instanceof ApiError ? error.code : undefined;
}

export function errorMessage(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error) return error.message;
  return "Something went wrong";
}
