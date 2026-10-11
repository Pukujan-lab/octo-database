import { useCallback, useEffect, useState } from "react";
import { api, errorMessage } from "@/lib/api";

/** Destructive and credential-creating calls are gated behind a short-lived
 *  code that a human types. Fetch a fresh code each time a gated form opens. */
export function useConfirmChallenge(open: boolean) {
  const [code, setCode] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const request = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await api.post<{ code: string }>("/api/me/confirm-challenge", {});
      setCode(result.code);
    } catch (err) {
      setCode(null);
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!open) {
      setCode(null);
      setError(null);
      return;
    }
    void request();
  }, [open, request]);

  return { code, loading, error, refresh: request };
}
