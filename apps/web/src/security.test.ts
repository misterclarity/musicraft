import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { HEADER_CSP, META_CSP } from "../security";

/** A file at the repository root (found by walking up from the working directory). */
function repo(path: string): string {
  let dir = process.cwd();
  while (!existsSync(join(dir, path)) && dirname(dir) !== dir) dir = dirname(dir);
  return readFileSync(join(dir, path), "utf8");
}

describe("Content-Security-Policy", () => {
  it("is the same in netlify.toml, vercel.json and the build's <meta> tag", () => {
    const netlify = /Content-Security-Policy = "([^"]+)"/.exec(repo("netlify.toml"))?.[1];
    const vercel = (JSON.parse(repo("vercel.json")) as { headers: { headers: { key: string; value: string }[] }[] }).headers[0]!.headers.find(
      (h) => h.key === "Content-Security-Policy",
    )?.value;
    expect(netlify).toBe(HEADER_CSP);
    expect(vercel).toBe(HEADER_CSP);
    expect(META_CSP).not.toContain("frame-ancestors"); // only valid as a header
    expect(HEADER_CSP.startsWith(META_CSP)).toBe(true);
  });
});
