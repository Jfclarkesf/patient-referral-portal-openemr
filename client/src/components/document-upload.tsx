import { useRef } from "react";
import { Button } from "@/components/ui/button";
import { FileText, Loader2, Upload, X, AlertCircle } from "lucide-react";
import { DOCUMENT_MAX_BYTES, DOCUMENT_MAX_FILES, DOCUMENT_TYPES } from "@shared/schema";

export interface PendingDocument {
  key: string;
  name: string;
  size: number;
  status: "uploading" | "uploaded" | "error";
  id?: string; // set once the server has the file
  error?: string;
}

const ACCEPT = [...Object.keys(DOCUMENT_TYPES), ...Object.values(DOCUMENT_TYPES)].join(",");

export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

// Some browsers leave the type empty (e.g. HEIC); fall back to the extension
function fileType(file: File): string {
  if (file.type) return file.type;
  const ext = "." + (file.name.split(".").pop() || "").toLowerCase();
  if (ext === ".jpeg") return "image/jpeg";
  if (ext === ".tiff") return "image/tiff";
  return Object.entries(DOCUMENT_TYPES).find(([, e]) => e === ext)?.[0] || "";
}

/**
 * File picker for a referral. Each file uploads as soon as it's picked, so
 * submitting the form only has to send the ids.
 */
export function DocumentUpload({
  documents,
  onChange,
  disabled,
}: {
  documents: PendingDocument[];
  onChange: (update: (docs: PendingDocument[]) => PendingDocument[]) => void;
  disabled?: boolean;
}) {
  const inputRef = useRef<HTMLInputElement>(null);

  const patch = (key: string, changes: Partial<PendingDocument>) =>
    onChange((docs) => docs.map((d) => (d.key === key ? { ...d, ...changes } : d)));

  const upload = async (file: File, key: string) => {
    try {
      const response = await fetch("/api/documents", {
        method: "POST",
        headers: {
          "Content-Type": fileType(file),
          "X-File-Name": encodeURIComponent(file.name),
        },
        body: file,
        credentials: "include",
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.message || "Upload failed");
      patch(key, { status: "uploaded", id: result.id });
    } catch (error: any) {
      patch(key, { status: "error", error: error.message || "Upload failed" });
    }
  };

  const handleFiles = (files: FileList | null) => {
    if (!files) return;
    const room = DOCUMENT_MAX_FILES - documents.length;
    const added: PendingDocument[] = [];

    for (const file of Array.from(files)) {
      const key = `${file.name}-${file.size}-${Math.random().toString(36).slice(2)}`;
      const base = { key, name: file.name, size: file.size };
      if (added.length >= room) {
        added.push({ ...base, status: "error", error: `Only ${DOCUMENT_MAX_FILES} files per referral` });
      } else if (!DOCUMENT_TYPES[fileType(file)]) {
        added.push({ ...base, status: "error", error: "Unsupported type. Use PDF, an image, Word or text." });
      } else if (file.size > DOCUMENT_MAX_BYTES) {
        added.push({ ...base, status: "error", error: `Larger than ${formatFileSize(DOCUMENT_MAX_BYTES)}` });
      } else if (file.size === 0) {
        added.push({ ...base, status: "error", error: "The file is empty" });
      } else {
        added.push({ ...base, status: "uploading" });
        upload(file, key);
      }
    }

    onChange((docs) => [...docs, ...added]);
    if (inputRef.current) inputRef.current.value = "";
  };

  const remove = (doc: PendingDocument) => {
    onChange((docs) => docs.filter((d) => d.key !== doc.key));
    if (doc.id) {
      fetch(`/api/documents/${doc.id}`, { method: "DELETE", credentials: "include" }).catch(() => {});
    }
  };

  const count = documents.filter((d) => d.status !== "error").length;

  return (
    <div className="space-y-3">
      <div
        className="rounded-lg border-2 border-dashed p-6 text-center"
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault();
          if (!disabled) handleFiles(e.dataTransfer.files);
        }}
      >
        <Upload className="mx-auto h-8 w-8 text-muted-foreground" />
        <p className="mt-2 text-sm text-muted-foreground">
          Drag files here, or
        </p>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="mt-2"
          onClick={() => inputRef.current?.click()}
          disabled={disabled || count >= DOCUMENT_MAX_FILES}
          data-testid="button-choose-documents"
        >
          Choose files
        </Button>
        <p className="mt-2 text-xs text-muted-foreground">
          PDF, images, Word or text. Up to {DOCUMENT_MAX_FILES} files, {formatFileSize(DOCUMENT_MAX_BYTES)} each.
        </p>
        <input
          ref={inputRef}
          type="file"
          multiple
          accept={ACCEPT}
          className="hidden"
          onChange={(e) => handleFiles(e.target.files)}
          data-testid="input-documents"
        />
      </div>

      {documents.length > 0 && (
        <ul className="divide-y rounded-md border" data-testid="list-documents">
          {documents.map((doc) => (
            <li key={doc.key} className="flex items-center gap-3 p-3 text-sm">
              {doc.status === "uploading" ? (
                <Loader2 className="h-4 w-4 shrink-0 animate-spin text-muted-foreground" />
              ) : doc.status === "error" ? (
                <AlertCircle className="h-4 w-4 shrink-0 text-destructive" />
              ) : (
                <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />
              )}
              <div className="min-w-0 flex-1">
                <p className="truncate font-medium">{doc.name}</p>
                <p className={`text-xs ${doc.status === "error" ? "text-destructive" : "text-muted-foreground"}`}>
                  {doc.status === "error" ? doc.error : doc.status === "uploading" ? "Uploading..." : formatFileSize(doc.size)}
                </p>
              </div>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="h-8 w-8 shrink-0"
                onClick={() => remove(doc)}
                disabled={disabled}
                aria-label={`Remove ${doc.name}`}
                data-testid="button-remove-document"
              >
                <X className="h-4 w-4" />
              </Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
