import { DOMParser } from "@xmldom/xmldom";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { importMusicXml, type ImportOptions, type XmlParser } from "../src";

export const parser = new DOMParser() as unknown as XmlParser;

const here = dirname(fileURLToPath(import.meta.url));

export function fixture(name: string): string {
  return readFileSync(join(here, "fixtures", name), "utf8");
}

export function load(name: string, options: ImportOptions = {}) {
  return importMusicXml(fixture(name), { parser, ...options });
}

export function importText(text: string, options: ImportOptions = {}) {
  return importMusicXml(text, { parser, ...options });
}

/** Parse exported XML back into a DOM document for assertions. */
export function xmlDoc(text: string): Document {
  return parser.parseFromString(text, "application/xml");
}

export function texts(doc: Document, tag: string): string[] {
  const out: string[] = [];
  const list = doc.getElementsByTagName(tag);
  for (let i = 0; i < list.length; i++) out.push(list[i]!.textContent ?? "");
  return out;
}
