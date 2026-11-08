/** Small helpers for files: downloads, names and type detection. */

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

export function downloadBytes(bytes: Uint8Array, filename: string, mime: string): void {
  downloadBlob(new Blob([bytes as BlobPart], { type: mime }), filename);
}

export function downloadText(text: string, filename: string, mime: string): void {
  downloadBlob(new Blob([text], { type: mime }), filename);
}

/** A file name from a title: "Maple Leaf Rag" → "Maple Leaf Rag". Strips characters file systems dislike. */
export function safeFileName(name: string, fallback = "score"): string {
  const cleaned = name.replace(/[\\/:*?"<>|]+/g, " ").replace(/\s+/g, " ").trim();
  return cleaned.slice(0, 80) || fallback;
}

export type InputKind = "musicxml" | "mxl" | "project" | "pdf" | "image" | "unknown";

export function detectKind(file: File): InputKind {
  const name = file.name.toLowerCase();
  if (name.endsWith(".musicraft")) return "project";
  if (name.endsWith(".mxl")) return "mxl";
  if (name.endsWith(".musicxml") || name.endsWith(".xml")) return "musicxml";
  if (name.endsWith(".pdf") || file.type === "application/pdf") return "pdf";
  if (file.type.startsWith("image/") || /\.(jpe?g|png|heic|heif|webp|tiff?|bmp)$/.test(name)) return "image";
  return "unknown";
}

export async function readBytes(file: Blob): Promise<Uint8Array> {
  return new Uint8Array(await file.arrayBuffer());
}

export function baseName(fileName: string): string {
  return fileName.replace(/\.[^.]+$/, "");
}
