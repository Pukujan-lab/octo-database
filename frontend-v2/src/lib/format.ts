import { formatDistanceToNowStrict, isValid, parseISO } from "date-fns";

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const index = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const value = bytes / 1024 ** index;
  const digits = index === 0 || value >= 100 ? 0 : value >= 10 ? 1 : 2;
  return `${value.toFixed(digits)} ${units[index]}`;
}

export function formatCount(value: number): string {
  return new Intl.NumberFormat("en-US").format(value);
}

export function formatDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const date = parseISO(iso);
  if (!isValid(date)) return iso;
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const date = parseISO(iso);
  if (!isValid(date)) return iso;
  return date.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function formatRelative(iso: string | null | undefined): string {
  if (!iso) return "—";
  const date = parseISO(iso);
  if (!isValid(date)) return iso;
  return `${formatDistanceToNowStrict(date)} ago`;
}

export function formatClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

/** `2024-05-01` -> `May 1` — compact axis labels for charts. */
export function formatDayLabel(day: string): string {
  const date = parseISO(day);
  if (!isValid(date)) return day;
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

export function shortId(value: string, head = 8): string {
  if (!value) return "—";
  return value.length > head + 4 ? `${value.slice(0, head)}…` : value;
}

export function titleFromMime(mimeType: string): string {
  return mimeType || "application/octet-stream";
}
