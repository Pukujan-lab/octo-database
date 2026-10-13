import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { errorMessage } from "@/lib/api";
import { useUploadFile } from "@/lib/files";
import { toast } from "@/utils/toast";
import { FilePlus2 } from "lucide-react";

/** Creates a plain-text object through the same upload route as binary files,
 *  with `dataEncoding: 'utf8'`. */
export function NewTextFileDialog({
  workspaceId,
  onCreated,
  variant = "default",
  size = "sm",
}: {
  workspaceId: string;
  onCreated: () => void;
  variant?: "default" | "outline";
  size?: "sm" | "default";
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("notes.txt");
  const [body, setBody] = useState("");
  const upload = useUploadFile();

  async function submit() {
    const trimmed = name.trim() || "untitled";
    if (!body.trim()) {
      toast.error("Give the text file some content first");
      return;
    }
    try {
      await upload.mutateAsync({
        workspaceId,
        name: trimmed.endsWith(".txt") ? trimmed : `${trimmed}.txt`,
        mimeType: "text/plain",
        data: body,
        dataEncoding: "utf8",
      });
      toast.success("Text file created");
      setBody("");
      setOpen(false);
      onCreated();
    } catch (error) {
      toast.error(errorMessage(error));
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size={size} variant={variant} className="gap-2">
          <FilePlus2 className="h-4 w-4" /> New text file
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New text file</DialogTitle>
          <DialogDescription>Stored as a plain-text object in the active workspace.</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="text-file-name">Name</Label>
            <Input id="text-file-name" value={name} onChange={(event) => setName(event.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="text-file-body">Content</Label>
            <Textarea
              id="text-file-body"
              rows={8}
              value={body}
              placeholder="Write anything…"
              onChange={(event) => setBody(event.target.value)}
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button onClick={() => void submit()} disabled={upload.isPending}>
            {upload.isPending ? "Saving…" : "Create file"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
