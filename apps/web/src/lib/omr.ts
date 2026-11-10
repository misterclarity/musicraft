import { joinUrl, omrBaseUrl, serverFetch, serverJson } from "./server";
import type { Settings } from "./settings";

export type Corners = [number, number][];

export interface OmrStaff {
  x: number;
  y: number;
  width: number;
  height: number;
  grand?: boolean;
}

export interface OmrPage {
  index: number;
  status: "pending" | "done" | "failed";
  width: number;
  height: number;
  staffs: OmrStaff[];
  error: string | null;
  musicxml?: string | null;
  /** The engine that read `musicxml`, e.g. "homr 0.7.0". */
  readBy?: string | null;
  /** The second engine's reading of the page, when the job asked for one. */
  alternative?: { readBy: string; musicxml: string; staffs: OmrStaff[] } | null;
}

export interface OmrJob {
  id: string;
  status: "queued" | "preparing" | "running" | "done" | "failed" | "canceled";
  progress: { done: number; total: number; stage: string };
  error: string | null;
  /** Whether every page is also read by the second engine, and why that failed if it did. */
  second?: boolean;
  secondError?: string | null;
  pages: OmrPage[];
}

export interface PageRequest {
  /** Index into the uploaded files. */
  file: number;
  /** Page of a PDF (0-based). */
  page?: number;
  /** Corners of the sheet (top-left, top-right, bottom-right, bottom-left), 0–1. */
  corners?: Corners;
  /** Extra clockwise rotation in degrees. */
  rotation?: number;
}

export async function detectCorners(settings: Settings, file: Blob): Promise<{ corners: Corners | null; confidence: number }> {
  const form = new FormData();
  form.append("file", file, "photo");
  return serverJson(settings, joinUrl(omrBaseUrl(settings), "/v1/pages/detect"), { method: "POST", body: form, timeoutMs: 60_000 });
}

export async function startJob(settings: Settings, files: File[], pages: PageRequest[], options: { second?: boolean } = {}): Promise<OmrJob> {
  const form = new FormData();
  for (const file of files) form.append("files", file, file.name);
  form.append("options", JSON.stringify({ pages, ...(options.second ? { second: true } : {}) }));
  return serverJson<OmrJob>(settings, joinUrl(omrBaseUrl(settings), "/v1/omr/jobs"), {
    method: "POST",
    body: form,
    timeoutMs: 180_000,
  });
}

export async function getJob(settings: Settings, id: string): Promise<OmrJob> {
  return serverJson<OmrJob>(settings, joinUrl(omrBaseUrl(settings), `/v1/omr/jobs/${id}`), { timeoutMs: 30_000 });
}

export async function getPageImage(settings: Settings, id: string, index: number): Promise<Blob> {
  const response = await serverFetch(settings, joinUrl(omrBaseUrl(settings), `/v1/omr/jobs/${id}/pages/${index}/image`), {
    timeoutMs: 60_000,
  });
  return response.blob();
}

export async function deleteJob(settings: Settings, id: string): Promise<void> {
  try {
    await serverFetch(settings, joinUrl(omrBaseUrl(settings), `/v1/omr/jobs/${id}`), { method: "DELETE", timeoutMs: 15_000 });
  } catch {
    // The job expires on the server anyway.
  }
}
