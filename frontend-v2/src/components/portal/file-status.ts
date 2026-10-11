import type { PillTone } from "./Panel";

export type FileStatus = { label: string; tone: PillTone };

/** Status is derived from the object's archive state, not stored separately. */
export function fileArchiveLabel(archiveState: string | null | undefined): FileStatus {
  const state = (archiveState ?? "").toLowerCase();
  if (state === "archived_drive") return { label: "Archived", tone: "info" };
  if (state === "archiving" || state === "restoring") return { label: "Transitioning", tone: "warning" };
  return { label: "Ready", tone: "success" };
}

export function fileIsArchived(archiveState: string | null | undefined): boolean {
  return (archiveState ?? "").toLowerCase() === "archived_drive";
}

export function jobStateTone(state: string): PillTone {
  switch ((state ?? "").toLowerCase()) {
    case "failed":
      return "danger";
    case "queued":
      return "warning";
    case "running":
    case "active":
      return "info";
    case "completed":
    case "succeeded":
      return "success";
    case "dead":
    case "cancelled":
      return "muted";
    default:
      return "neutral";
  }
}

export function shareState(row: { revokedAt: string | null; validUntil: string | null }): {
  label: string;
  tone: PillTone;
  active: boolean;
} {
  if (row.revokedAt) return { label: "Revoked", tone: "muted", active: false };
  if (row.validUntil && new Date(row.validUntil).getTime() < Date.now()) {
    return { label: "Expired", tone: "warning", active: false };
  }
  return { label: "Active", tone: "success", active: true };
}
