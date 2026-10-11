import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "./api";
import type { FileRecord } from "./types";

export type UploadInput = {
  workspaceId: string;
  name: string;
  mimeType: string;
  data: string;
  dataEncoding: "base64" | "utf8";
};

/** Read a File as bytes and base64-encode it. Chunked so large files do not
 *  blow the call stack of `String.fromCharCode.apply`. */
export async function fileToBase64(file: File): Promise<string> {
  const buffer = await file.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunk = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunk) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunk));
  }
  return btoa(binary);
}

export function useUploadFile() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: UploadInput) => api.post<FileRecord>("/api/files/upload", input),
    onSuccess: (_file, input) => invalidateWorkspace(queryClient, input.workspaceId),
  });
}

export function invalidateWorkspace(
  queryClient: ReturnType<typeof useQueryClient>,
  workspaceId: string,
) {
  for (const key of ["files", "gallery", "jobs", "activity", "shares", "ops-summary", "keys"]) {
    queryClient.invalidateQueries({ queryKey: [key, workspaceId] });
  }
}

export function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename || "download";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 2000);
}
