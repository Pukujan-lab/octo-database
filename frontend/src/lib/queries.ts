import { useQuery } from "@tanstack/react-query";
import { api, qs } from "@/lib/api";
import type {
  ActivityRow,
  ApiKey,
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
