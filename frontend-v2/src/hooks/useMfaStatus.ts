import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import type { MfaStatus } from "@/lib/types";

/** Fresh MFA state for the Access view (enabled, confirmedAt, codes remaining). */
export function useMfaStatus(enabled = true) {
  return useQuery({
    queryKey: ["mfa-status"],
    enabled,
    staleTime: 20 * 1000,
    queryFn: () => api.get<MfaStatus>("/api/me/mfa"),
  });
}
