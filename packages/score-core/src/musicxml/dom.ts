/** Minimal helpers over the standard DOM API, so the same code runs on the browser's DOMParser and xmldom. */

export interface XmlParser {
  parseFromString(text: string, mimeType: "text/xml" | "application/xml"): Document;
}

export function defaultParser(): XmlParser {
  const Ctor = (globalThis as { DOMParser?: new () => XmlParser }).DOMParser;
  if (!Ctor) throw new Error("No DOMParser available; pass one in the options (e.g. from @xmldom/xmldom).");
  return new Ctor();
}

export function parseXml(text: string, parser: XmlParser = defaultParser()): Element {
  const doc = parser.parseFromString(text, "application/xml");
  const root = doc.documentElement;
  if (!root || root.nodeName === "parsererror" || doc.getElementsByTagName("parsererror").length > 0) {
    throw new Error("The file is not well-formed XML.");
  }
  return root;
}

export function elements(parent: Element | null | undefined, name?: string): Element[] {
  const out: Element[] = [];
  if (!parent) return out;
  const nodes = parent.childNodes;
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i]!;
    if (node.nodeType === 1 && (name === undefined || node.nodeName === name)) out.push(node as Element);
  }
  return out;
}

export function child(parent: Element | null | undefined, name: string): Element | undefined {
  if (!parent) return undefined;
  const nodes = parent.childNodes;
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i]!;
    if (node.nodeType === 1 && node.nodeName === name) return node as Element;
  }
  return undefined;
}

export function childText(parent: Element | null | undefined, name: string): string | undefined {
  const el = child(parent, name);
  const text = el?.textContent?.trim();
  return text === undefined || text === "" ? undefined : text;
}

export function childNumber(parent: Element | null | undefined, name: string): number | undefined {
  const text = childText(parent, name);
  if (text === undefined) return undefined;
  const value = Number(text);
  return Number.isFinite(value) ? value : undefined;
}

export function path(parent: Element | null | undefined, ...names: string[]): Element | undefined {
  let current: Element | undefined = parent ?? undefined;
  for (const name of names) current = child(current, name);
  return current;
}

/** Comments directly inside an element (homr writes note positions as comments). */
export function childComments(parent: Element): string[] {
  const out: string[] = [];
  const nodes = parent.childNodes;
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i]!;
    if (node.nodeType === 8) out.push(node.nodeValue ?? "");
  }
  return out;
}

export function decodeXmlBytes(bytes: Uint8Array): string {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder("utf-16le").decode(bytes.subarray(2));
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder("utf-16be").decode(bytes.subarray(2));
  return new TextDecoder("utf-8").decode(bytes);
}

const XML_ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" };

export function escapeXml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => XML_ESCAPES[c]!);
}
