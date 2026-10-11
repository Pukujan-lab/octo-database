import { useState } from "react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Panel, StatusPill } from "@/components/portal/Panel";
import { EmptyState, ErrorState } from "@/components/portal/EmptyState";
import { NewTextFileDialog } from "@/components/portal/NewTextFileDialog";
import { api, errorMessage, fetchBlob } from "@/lib/api";
import { downloadBlob } from "@/lib/files";
import { formatBytes, formatDate } from "@/lib/format";
import { fileArchiveLabel, fileIsArchived } from "@/components/portal/file-status";
import { useFilePicker } from "@/hooks/useFilePicker";
import type { WorkspaceData } from "@/lib/workspace-data";
import type { FileRecord } from "@/lib/types";
import { toast } from "@/utils/toast";
import { Archive, Download, HardDrive, RotateCcw, Trash2, Upload } from "lucide-react";

export function FilesView({ workspaceId, data }: { workspaceId: string; data: WorkspaceData }) {
  const [busyRow, setBusyRow] = useState<string | null>(null);
  const [removeTarget, setRemoveTarget] = useState<FileRecord | null>(null);
  const picker = useFilePicker(workspaceId, () => data.reload());
  const files = data.files.data ?? [];
  const totalBytes = files.reduce((sum, file) => sum + (file.sizeBytes || 0), 0);

  async function download(file: FileRecord) {
    setBusyRow(file.id);
    try {
      const blob = await fetchBlob(
        `/api/files/content?workspaceId=${encodeURIComponent(workspaceId)}&fileId=${encodeURIComponent(file.id)}`,
      );
      downloadBlob(blob, file.name);
      toast.success(`Downloading ${file.name}`);
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setBusyRow(null);
    }
  }

  async function transition(file: FileRecord, direction: "archive" | "restore") {
    setBusyRow(file.id);
    try {
      const result = await api.post<{ created: boolean }>(
        `/api/files/${file.id}/${direction}?workspaceId=${encodeURIComponent(workspaceId)}`,
        {},
      );
      toast.success(
        `${direction === "archive" ? "Archive" : "Restore"} job ${result.created ? "queued" : "already queued"}`,
      );
      data.reload();
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setBusyRow(null);
    }
  }

  async function remove(file: FileRecord) {
    setBusyRow(file.id);
    try {
      await api.del<{ success: boolean }>(
        `/api/files/${file.id}?workspaceId=${encodeURIComponent(workspaceId)}`,
      );
      toast.success(`Removed ${file.name}`);
      setRemoveTarget(null);
      data.reload();
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setBusyRow(null);
    }
  }

  return (
    <div data-testid="view-files" className="animate-fade-rise space-y-6">
      {picker.input}

      <Panel
        eyebrow="Objects"
        title="Workspace files"
        action={
          <>
            <Button size="sm" onClick={picker.open} disabled={picker.uploading} className="gap-2">
              <Upload className="h-4 w-4" /> {picker.uploading ? "Uploading…" : "Upload files"}
            </Button>
            <NewTextFileDialog workspaceId={workspaceId} onCreated={data.reload} variant="outline" />
          </>
        }
        bodyClassName="min-h-[260px]"
      >
        {data.files.isError ? (
          <ErrorState title="Could not load files" detail={errorMessage(data.files.error)} onRetry={() => data.files.refetch()} />
        ) : data.files.isPending ? (
          <div className="space-y-2 p-5">
            {[0, 1, 2, 3, 4].map((row) => (
              <Skeleton key={row} className="h-12 w-full" />
            ))}
          </div>
        ) : files.length === 0 ? (
          <EmptyState
            title="This workspace has no files"
            description="Upload objects from disk, or create a plain-text file directly from the portal."
            action={
              <div className="flex flex-wrap justify-center gap-2">
                <Button size="sm" onClick={picker.open} className="gap-2">
                  <Upload className="h-4 w-4" /> Upload files
                </Button>
                <NewTextFileDialog workspaceId={workspaceId} onCreated={data.reload} variant="outline" />
              </div>
            }
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Size</th>
                  <th>Status</th>
                  <th className="hidden md:table-cell">Added</th>
                  <th className="hidden lg:table-cell">Storage key</th>
                  <th className="text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {files.map((file) => {
                  const status = fileArchiveLabel(file.archiveState);
                  const busy = busyRow === file.id;
                  return (
                    <tr key={file.id} className={busy ? "opacity-60" : undefined}>
                      <td>
                        <div className="max-w-[300px] space-y-0.5">
                          <p className="truncate font-medium">{file.name}</p>
                          <p className="num truncate text-[11px] text-muted-foreground">{file.mimeType}</p>
                        </div>
                      </td>
                      <td className="num whitespace-nowrap text-xs">{formatBytes(file.sizeBytes)}</td>
                      <td>
                        <div className="flex flex-wrap gap-1.5">
                          <StatusPill tone={status.tone} dot>
                            {status.label}
                          </StatusPill>
                          {file.publishedUrl ? <StatusPill tone="primary">published</StatusPill> : null}
                        </div>
                      </td>
                      <td className="hidden whitespace-nowrap text-xs text-muted-foreground md:table-cell">
                        {formatDate(file.createdAt)}
                      </td>
                      <td className="num hidden max-w-[220px] truncate text-[11px] text-muted-foreground lg:table-cell">
                        {file.storageKey}
                      </td>
                      <td>
                        <div className="flex items-center justify-end gap-1">
                          <Button
                            size="icon"
                            variant="ghost"
                            className="h-8 w-8"
                            title="Download"
                            aria-label={`Download ${file.name}`}
                            onClick={() => void download(file)}
                            disabled={busy}
                          >
                            <Download className="h-4 w-4" />
                          </Button>
                          {fileIsArchived(file.archiveState) ? (
                            <Button
                              size="icon"
                              variant="ghost"
                              className="h-8 w-8"
                              title="Restore from archive"
                              aria-label={`Restore ${file.name}`}
                              onClick={() => void transition(file, "restore")}
                              disabled={busy}
                            >
                              <RotateCcw className="h-4 w-4" />
                            </Button>
                          ) : (
                            <Button
                              size="icon"
                              variant="ghost"
                              className="h-8 w-8"
                              title="Archive to drive"
                              aria-label={`Archive ${file.name}`}
                              onClick={() => void transition(file, "archive")}
                              disabled={busy || (file.archiveState ?? "").toLowerCase() === "archiving"}
                            >
                              <Archive className="h-4 w-4" />
                            </Button>
                          )}
                          <Button
                            size="icon"
                            variant="ghost"
                            className="h-8 w-8 text-muted-foreground hover:text-destructive"
                            title="Remove"
                            aria-label={`Remove ${file.name}`}
                            onClick={() => setRemoveTarget(file)}
                            disabled={busy}
                          >
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      <p className="flex items-center gap-2 text-xs text-muted-foreground">
        <HardDrive className="h-3.5 w-3.5 shrink-0" />
        <span className="num">{files.length}</span> objects · <span className="num">{formatBytes(totalBytes)}</span>{" "}
        recorded · archive and restore run as background jobs
      </p>

      <AlertDialog open={Boolean(removeTarget)} onOpenChange={(open) => !open && setRemoveTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove {removeTarget?.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              The object is deleted from storage and its row leaves the catalog. This cannot be
              undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep it</AlertDialogCancel>
            <AlertDialogAction onClick={() => removeTarget && void remove(removeTarget)}>
              Remove file
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
