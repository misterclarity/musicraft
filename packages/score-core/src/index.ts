export const SCORE_CORE_VERSION = "0.1.0";

export * from "./fraction";
export * from "./pitch";
export * from "./duration";
export * from "./ids";
export * from "./model";
export * from "./instruments";
export * from "./transpose";
export * from "./checks";
export * from "./performance";
export * from "./midi";
export * from "./ops";
export * from "./omr";
export * from "./edit";
export * from "./harmony";
export * from "./ai";
export { importMusicXml, importMxl, importMusicFile, type ImportOptions, type ImportResult } from "./musicxml/import";
export {
  exportMusicXml,
  exportMxl,
  beamGroupLength,
  computeBeams,
  tupletGroups,
  type ExportOptions,
  type BeamValue,
} from "./musicxml/export";
export { parseXml, decodeXmlBytes, escapeXml, type XmlParser } from "./musicxml/dom";
