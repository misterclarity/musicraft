import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { chooseReading } from "./readings";

function repo(...parts: string[]): string {
  // Tests run from the package folder or the repository root.
  const root = process.cwd().endsWith(join("apps", "web")) ? join(process.cwd(), "..", "..") : process.cwd();
  return join(root, ...parts);
}

const clean = readFileSync(repo("packages/score-core/test/fixtures/trumpet-part.musicxml"), "utf8");
// The same page with the rest at the end of bar 1 missed.
const missing = clean.replace("<note><rest/><duration>12</duration><type>quarter</type></note>", "");
const staffs = [{ x: 0.1, y: 0.1, width: 0.8, height: 0.05 }];

describe("choosing between two readings of a page", () => {
  it("keeps the reading whose bars add up", () => {
    const chosen = chooseReading(
      [
        { readBy: "homr 0.8", musicxml: missing, staffs },
        { readBy: "homr 0.7.0", musicxml: clean, staffs: [{ ...staffs[0]!, y: 0.2 }] },
      ],
      "trumpet-bb",
      "page.png",
    );
    expect(chosen.reading.readBy).toBe("homr 0.7.0");
    expect(chosen.reading.staffs[0]!.y).toBe(0.2);
    expect(chosen.note).toBe("page.png: kept the second reading (homr 0.7.0): 7 of 7 bars with notes add up, against 6 of 7 in the first (homr 0.8).");
  });

  it("keeps the first reading on a tie, and uses whatever can be read", () => {
    const tie = chooseReading([{ musicxml: clean, staffs }, { musicxml: clean, staffs }], "trumpet-bb", "p");
    expect(tie.note).toBe("p: kept the first reading: 7 of 7 bars with notes add up, against 7 of 7 in the second.");
    const one = chooseReading([{ musicxml: "not music", staffs }, { readBy: "homr 0.7.0", musicxml: clean, staffs }], "trumpet-bb", "p");
    expect(one.note).toBe("p: only the second reading (homr 0.7.0) could be used.");
    expect(chooseReading([{ musicxml: clean, staffs }], "trumpet-bb", "p").note).toBeUndefined();
    expect(() => chooseReading([{ musicxml: "not music", staffs }], "trumpet-bb", "p")).toThrow();
  });
});
