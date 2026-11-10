import {
  exportMusicXml,
  getInstrument,
  newId,
  prettyName,
  SCORE_SCHEMA_VERSION,
  type Score,
} from "@musicraft/score-core";
import { gunzipSync, gzipSync, strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { db, type PageRecord, type ProjectRecord, type ProjectSource, type VersionAuthor } from "./db";

const MAX_VERSIONS = 80;

export interface ProjectSummary {
  id: string;
  name: string;
  updatedAt: number;
  createdAt: number;
  source: ProjectSource;
  parts: string;
  measures: number;
}

export function summarize(p: ProjectRecord): ProjectSummary {
  const names = p.score.parts.map((part) => prettyName(part.name || getInstrument(part.instrument).name));
  return {
    id: p.id,
    name: p.name,
    updatedAt: p.updatedAt,
    createdAt: p.createdAt,
    source: p.source,
    parts: names.length > 4 ? `${names.slice(0, 3).join(", ")} and ${names.length - 3} more` : names.join(", "),
    measures: p.score.measures.length,
  };
}

export async function listProjects(): Promise<ProjectSummary[]> {
  const all = await db.projects.orderBy("updatedAt").reverse().toArray();
  return all.map(summarize);
}

export async function getProject(id: string): Promise<ProjectRecord | undefined> {
  return db.projects.get(id);
}

export async function createProject(
  name: string,
  score: Score,
  source: ProjectSource,
  pages: Omit<PageRecord, "id" | "projectId">[] = [],
  firstVersionLabel?: string,
  /** An earlier state to keep in the history, e.g. a scan before its automatic corrections. */
  before?: { score: Score; label: string },
): Promise<string> {
  const id = newId("x");
  const now = Date.now();
  const author = source === "scan" ? "recognition" : source === "new" ? "you" : "import";
  await db.transaction("rw", db.projects, db.versions, db.pages, async () => {
    await db.projects.add({ id, name, createdAt: now, updatedAt: now, source, score });
    if (before) await addVersion(id, before.score, before.label, author, now - 1);
    await addVersion(id, score, firstVersionLabel ?? (source === "scan" ? "Recognised from scan" : "Imported"), author, now);
    for (const page of pages) await db.pages.add({ ...page, projectId: id });
  });
  void requestPersistentStorage();
  return id;
}

export async function saveScore(id: string, score: Score): Promise<void> {
  await db.projects.update(id, { score, updatedAt: Date.now() });
}

export async function renameProject(id: string, name: string): Promise<void> {
  await db.projects.update(id, { name, updatedAt: Date.now() });
}

export async function deleteProject(id: string): Promise<void> {
  await db.transaction("rw", db.projects, db.versions, db.pages, async () => {
    await db.projects.delete(id);
    await db.versions.where("projectId").equals(id).delete();
    await db.pages.where("projectId").equals(id).delete();
  });
}

export async function duplicateProject(id: string): Promise<string | undefined> {
  const project = await getProject(id);
  if (!project) return undefined;
  const pages = await db.pages.where("projectId").equals(id).toArray();
  return createProject(
    `${project.name} (copy)`,
    project.score,
    project.source,
    pages.map(({ id: _id, projectId: _p, ...rest }) => rest),
  );
}

// ---------------------------------------------------------------------------
// Versions
// ---------------------------------------------------------------------------

export interface VersionSummary {
  id: number;
  createdAt: number;
  label: string;
  author: VersionAuthor;
}

export async function addVersion(projectId: string, score: Score, label: string, author: VersionAuthor, createdAt = Date.now()): Promise<void> {
  const data = gzipSync(strToU8(JSON.stringify(score)), { level: 6 });
  await db.versions.add({ projectId, createdAt, label, author, data });
  const count = await db.versions.where("projectId").equals(projectId).count();
  if (count > MAX_VERSIONS) {
    const oldest = await db.versions
      .where("projectId")
      .equals(projectId)
      .sortBy("createdAt");
    const remove = oldest.slice(0, count - MAX_VERSIONS).map((v) => v.id!);
    await db.versions.bulkDelete(remove);
  }
}

export async function listVersions(projectId: string): Promise<VersionSummary[]> {
  const versions = await db.versions.where("projectId").equals(projectId).sortBy("createdAt");
  return versions.reverse().map(({ id, createdAt, label, author }) => ({ id: id!, createdAt, label, author }));
}

export async function loadVersion(id: number): Promise<Score | undefined> {
  const version = await db.versions.get(id);
  return version ? (JSON.parse(strFromU8(gunzipSync(version.data))) as Score) : undefined;
}

// ---------------------------------------------------------------------------
// Pages (original images of recognised scores)
// ---------------------------------------------------------------------------

export async function listPages(projectId: string): Promise<PageRecord[]> {
  return db.pages.where("projectId").equals(projectId).sortBy("index");
}

// ---------------------------------------------------------------------------
// Project files (.musicraft): a zip with the score, a MusicXML copy and the page images
// ---------------------------------------------------------------------------

interface ProjectFileManifest {
  format: "musicraft";
  version: 1;
  name: string;
  createdAt: number;
  source: ProjectSource;
  score: Score;
  pages: { file: string; index: number; name: string; width: number; height: number; layout?: PageRecord["layout"] }[];
}

export async function exportProjectFile(id: string): Promise<Blob> {
  const project = await getProject(id);
  if (!project) throw new Error("Project not found.");
  const pages = await listPages(id);
  const files: Record<string, Uint8Array | [Uint8Array, { level: 0 }]> = {};
  const manifest: ProjectFileManifest = {
    format: "musicraft",
    version: 1,
    name: project.name,
    createdAt: project.createdAt,
    source: project.source,
    score: project.score,
    pages: [],
  };
  for (const page of pages) {
    const extension = page.blob.type === "image/png" ? "png" : page.blob.type === "image/webp" ? "webp" : "jpg";
    const file = `pages/page-${String(page.index + 1).padStart(3, "0")}.${extension}`;
    files[file] = [new Uint8Array(await page.blob.arrayBuffer()), { level: 0 }];
    manifest.pages.push({ file, index: page.index, name: page.name, width: page.width, height: page.height, layout: page.layout });
  }
  files["project.json"] = strToU8(JSON.stringify(manifest));
  files["score.musicxml"] = strToU8(exportMusicXml(project.score));
  return new Blob([zipSync(files, { level: 6 }) as BlobPart], { type: "application/zip" });
}

export async function importProjectFile(bytes: Uint8Array): Promise<string> {
  let manifest: ProjectFileManifest;
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(bytes);
    manifest = JSON.parse(strFromU8(files["project.json"]!)) as ProjectFileManifest;
  } catch {
    throw new Error("This is not a Musicraft project file.");
  }
  if (manifest.format !== "musicraft" || !manifest.score) throw new Error("This is not a Musicraft project file.");
  if ((manifest.score.schemaVersion ?? 1) > SCORE_SCHEMA_VERSION) {
    throw new Error("This project was saved by a newer version of Musicraft.");
  }
  const pages: Omit<PageRecord, "id" | "projectId">[] = manifest.pages.map((p) => {
    const data = files[p.file];
    const type = p.file.endsWith(".png") ? "image/png" : p.file.endsWith(".webp") ? "image/webp" : "image/jpeg";
    return {
      index: p.index,
      name: p.name,
      width: p.width,
      height: p.height,
      layout: p.layout,
      blob: new Blob(data ? [data as BlobPart] : [], { type }),
    };
  });
  return createProject(manifest.name, manifest.score, manifest.source ?? "project-file", pages);
}

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

/** Ask the browser not to evict our data under storage pressure. */
export async function requestPersistentStorage(): Promise<boolean> {
  try {
    if (!navigator.storage?.persist) return false;
    if (await navigator.storage.persisted()) return true;
    return await navigator.storage.persist();
  } catch {
    return false;
  }
}

export async function storageEstimate(): Promise<{ usage: number; quota: number; persisted: boolean } | undefined> {
  try {
    const estimate = await navigator.storage.estimate();
    return {
      usage: estimate.usage ?? 0,
      quota: estimate.quota ?? 0,
      persisted: (await navigator.storage.persisted?.()) ?? false,
    };
  } catch {
    return undefined;
  }
}
