import { useMemo } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useActivity,
  useFiles,
  useGallery,
  useJobs,
  useKeys,
  useOpsSummary,
  useShares,
} from "./queries";
import { invalidateWorkspace } from "./files";

const SECTION_LABELS = {
  files: "files",
  gallery: "media",
  jobs: "jobs",
  activity: "activity",
  shares: "share links",
  keys: "API keys",
  opsSummary: "ops summary",
} as const;

/** One parallel batch of workspace-scoped requests, loaded when a workspace is
 *  selected. Tracks which sections failed so an error never masquerades as an
 *  empty workspace. */
export function useWorkspaceData(workspaceId: string) {
  const queryClient = useQueryClient();
  const files = useFiles(workspaceId);
  const gallery = useGallery(workspaceId);
  const jobs = useJobs(workspaceId);
  const activity = useActivity(workspaceId);
  const shares = useShares(workspaceId);
  const keys = useKeys(workspaceId);
  const opsSummary = useOpsSummary(workspaceId);

  const failedSections = useMemo(() => {
    const flags = {
      files: files.isError,
      gallery: gallery.isError,
      jobs: jobs.isError,
      activity: activity.isError,
      shares: shares.isError,
      keys: keys.isError,
      opsSummary: opsSummary.isError,
    };
    return (Object.keys(SECTION_LABELS) as Array<keyof typeof SECTION_LABELS>)
      .filter((key) => flags[key])
      .map((key) => SECTION_LABELS[key]);
  }, [
    files.isError,
    gallery.isError,
    jobs.isError,
    activity.isError,
    shares.isError,
    keys.isError,
    opsSummary.isError,
  ]);

  const reload = useMemo(
    () => () => invalidateWorkspace(queryClient, workspaceId),
    [queryClient, workspaceId],
  );

  return {
    workspaceId,
    files,
    gallery,
    jobs,
    activity,
    shares,
    keys,
    opsSummary,
    failedSections,
    reload,
  };
}

export type WorkspaceData = ReturnType<typeof useWorkspaceData>;
