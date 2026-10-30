import { useQuery } from "@tanstack/react-query";
import { api, qs } from "@/lib/api";
import type {
  ActivityRow,
  AnalyticsRows,
  AnalyticsRunSummary,
  ApiKey,
  DatasetSummary,
  FileRecord,
  GalleryItem,
  Health,
  JobRow,
  OpsSummary,
  ShareRow,
  Workspace,
} from "@/lib/types";

/** One query per collection, keyed by [resource, workspaceId]. */

export function useHealth() {
  return useQuery({
    queryKey: ["health"],
    staleTime: 5 * 60 * 1000,
    queryFn: () => api.get<Health>("/health", { authMode: "public" }),
  });
}

export interface ServiceLink {
  id: string;
  label: string;
  tool: string;
  url: string | null;
}

export function useServices() {
  return useQuery({
    queryKey: ["services"],
    staleTime: 5 * 60 * 1000,
    queryFn: () => api.get<{ services: ServiceLink[] }>("/api/services"),
  });
}

export function useWorkspaces(enabled = true) {
  return useQuery({
    queryKey: ["workspaces"],
    enabled,
    queryFn: () => api.get<Workspace[]>("/api/workspaces"),
  });
}

export function useFiles(workspaceId: string) {
  return useQuery({
    queryKey: ["files", workspaceId],
    enabled: Boolean(workspaceId),
    queryFn: () => api.get<FileRecord[]>(`/api/files${qs({ workspaceId })}`),
  });
}

export function useGallery(workspaceId: string) {
  return useQuery({
    queryKey: ["gallery", workspaceId],
    enabled: Boolean(workspaceId),
    queryFn: () => api.get<GalleryItem[]>(`/api/gallery${qs({ workspaceId })}`),
  });
}

export function useJobs(workspaceId: string) {
  return useQuery({
    queryKey: ["jobs", workspaceId],
    enabled: Boolean(workspaceId),
    queryFn: () => api.get<JobRow[]>(`/api/jobs${qs({ workspaceId })}`),
  });
}

export function useActivity(workspaceId: string) {
  return useQuery({
    queryKey: ["activity", workspaceId],
    enabled: Boolean(workspaceId),
    queryFn: () => api.get<ActivityRow[]>(`/api/activity${qs({ workspaceId })}`),
  });
}

export function useShares(workspaceId: string) {
  return useQuery({
    queryKey: ["shares", workspaceId],
    enabled: Boolean(workspaceId),
    queryFn: () => api.get<ShareRow[]>(`/api/workspaces/shares${qs({ workspaceId })}`),
  });
}

export function useKeys(workspaceId: string) {
  return useQuery({
    queryKey: ["keys", workspaceId],
    enabled: Boolean(workspaceId),
    queryFn: () => api.get<ApiKey[]>(`/api/keys${qs({ workspaceId })}`),
  });
}

export function useOpsSummary(workspaceId: string) {
  return useQuery({
    queryKey: ["ops-summary", workspaceId],
    enabled: Boolean(workspaceId),
    queryFn: () => api.get<OpsSummary>(`/api/ops/summary${qs({ workspaceId })}`),
  });
}

/** The workspace's registered lake datasets, newest version per dataset. */
export function useDatasets(workspaceId: string) {
  return useQuery({
    queryKey: ["datasets", workspaceId],
    enabled: Boolean(workspaceId),
    queryFn: () =>
      api.get<{ datasets: DatasetSummary[] }>(`/api/workspaces/${workspaceId}/datasets`),
  });
}

/** Recent analytics_query jobs for the workspace, newest first. */
export function useAnalyticsRuns(workspaceId: string) {
  return useQuery({
    queryKey: ["analytics-runs", workspaceId],
    enabled: Boolean(workspaceId),
    queryFn: () =>
      api.get<{ runs: AnalyticsRunSummary[] }>(`/api/workspaces/${workspaceId}/analytics/runs`),
  });
}

/** One completed result artifact, read back as JSON rows. */
export function useAnalyticsRows(workspaceId: string, resultId: string | null) {
  return useQuery({
    queryKey: ["analytics-rows", workspaceId, resultId],
    enabled: Boolean(workspaceId && resultId),
    queryFn: () =>
      api.get<AnalyticsRows>(
        `/api/workspaces/${workspaceId}/analytics/results/${resultId}/rows`,
      ),
  });
}
