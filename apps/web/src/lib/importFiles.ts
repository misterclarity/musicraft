import { importMusicFile } from "@musicraft/score-core";
import { baseName, detectKind, readBytes } from "./files";
import { createProject, importProjectFile } from "./projects";

export interface ImportOutcome {
  /** The project that was created, for notation and project files. */
  projectId?: string;
  warnings: string[];
  /** PDFs and photos, which go through recognition instead. */
  scans?: File[];
}

/** Open files the user dropped or picked: notation and project files directly, scans via recognition. */
export async function importFiles(files: File[]): Promise<ImportOutcome> {
  const scans = files.filter((f) => {
    const kind = detectKind(f);
    return kind === "pdf" || kind === "image";
  });
  const others = files.filter((f) => !scans.includes(f));
  if (scans.length > 0 && others.length === 0) return { scans, warnings: [] };

  const file = others[0];
  if (!file) return { warnings: [] };
  const kind = detectKind(file);
  const bytes = await readBytes(file);
  switch (kind) {
    case "project":
      return { projectId: await importProjectFile(bytes), warnings: [] };
    case "musicxml":
    case "mxl": {
      const result = importMusicFile(bytes);
      const title = result.score.meta.title && result.score.meta.title !== "Untitled" ? result.score.meta.title : baseName(file.name);
      const projectId = await createProject(title, result.score, "musicxml");
      return { projectId, warnings: result.warnings };
    }
    default:
      throw new Error(
        `"${file.name}" isn't a file Musicraft can open. Use MusicXML (.musicxml, .mxl), a Musicraft project, a PDF or a photo.`,
      );
  }
}
