import { useCallback, useRef, useState } from "react";
import { errorMessage } from "@/lib/api";
import { fileToBase64, useUploadFile } from "@/lib/files";
import { toast } from "@/utils/toast";

/** Owns one hidden multi-select input and the base64 upload path.
 *  Returns the element to render plus a function that opens the picker. */
export function useFilePicker(workspaceId: string, onUploaded?: (count: number) => void) {
  const ref = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const upload = useUploadFile();

  const open = useCallback(() => ref.current?.click(), []);

  const input = (
    <input
      ref={ref}
      data-testid="file-upload"
      type="file"
      multiple
      className="hidden"
      onChange={async (event) => {
        const list = event.target.files;
        if (!list?.length) return;
        setUploading(true);
        let done = 0;
        for (const file of Array.from(list)) {
          try {
            const encoded = await fileToBase64(file);
            await upload.mutateAsync({
              workspaceId,
              name: file.name,
              mimeType: file.type || "application/octet-stream",
              data: encoded,
              dataEncoding: "base64",
            });
            done += 1;
          } catch (error) {
            toast.error(`${file.name}: ${errorMessage(error)}`);
          }
        }
        if (done) toast.success(`Uploaded ${done} file${done === 1 ? "" : "s"}`);
        setUploading(false);
        event.target.value = "";
        onUploaded?.(done);
      }}
    />
  );

  return { input, open, uploading };
}
