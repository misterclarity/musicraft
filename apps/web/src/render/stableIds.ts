/**
 * Verovio gives every element it adds (staves, stems, beams, glyph definitions…) a generated id, and
 * one inserted note shifts every id after it. Renaming those ids page by page, in the order they
 * appear, makes a page an edit didn't touch come out exactly as before, so the screen replaces only
 * the pages that really changed. The score's own ids (bars, notes, rests) stay: the editor finds the
 * music by them.
 */

/** The ids in a MusicXML file (the ones to keep). */
export function idsIn(xml: string): Set<string> {
  const ids = new Set<string>();
  for (const match of xml.matchAll(/\bid="([^"]+)"/g)) ids.add(match[1]!);
  return ids;
}

/**
 * Rename the generated ids of one page to `v<page>-<n>`, wherever Verovio writes them: id and href
 * attributes, the classes that tie the pieces of a slur or tie together (`id-…`) or close a system
 * or page (`…MilestoneEnd <id>`), and the page's style rules (`#<id> g.tempo`).
 */
export function stableIds(svg: string, page: number, keep: Set<string>): string {
  const renamed = new Map<string, string>();
  const rename = (id: string) => {
    if (keep.has(id)) return id;
    let name = renamed.get(id);
    if (!name) renamed.set(id, (name = `v${page}-${renamed.size + 1}`));
    return name;
  };
  const renameClasses = (classes: string) => {
    const tokens = classes.split(" ");
    return tokens
      .map((token, i) => (token.startsWith("id-") ? `id-${rename(token.slice(3))}` : i > 0 && tokens[i - 1]!.endsWith("MilestoneEnd") ? rename(token) : token))
      .join(" ");
  };
  return svg.replace(
    /\b(id|href|class)="(#?)([^"]*)"|(<style\b[^>]*>)([^<]*)(?=<\/style>)/g,
    (whole, attribute: string | undefined, hash: string, value: string, styleTag: string | undefined, css: string) => {
      // Style rules may only name elements of this page (and are not colours like #000).
      if (styleTag) return styleTag + css.replace(/#([\w-]+)/g, (rule, id: string) => (renamed.has(id) ? `#${renamed.get(id)}` : rule));
      if (attribute === "class") return `class="${renameClasses(value)}"`;
      // A link elsewhere (href without #) is not an id.
      if (attribute === "href" && !hash) return whole;
      return `${attribute}="${hash}${rename(value)}"`;
    },
  );
}
