/**
 * How well a scan was read, measured once the user has corrected it: the scan's notes compared with
 * the score as it is now, overall and for each recognition engine.
 */
import { scanAccuracy, type Score } from "@musicraft/score-core";
import type { PageRecord } from "./db";
import { engineOfBars } from "./disagreements";

export type AccuracyResult = ReturnType<typeof scanAccuracy>;

/** Compare the scan (and the scan after its automatic corrections, if kept) with the corrected score. */
export function measureScan(scan: Score, corrected: Score, pages: PageRecord[], afterRepairs?: Score): { scan: AccuracyResult; afterRepairs?: AccuracyResult } {
  const engines = engineOfBars(scan, pages);
  return {
    scan: scanAccuracy(scan, corrected, (id) => engines.get(id)),
    ...(afterRepairs ? { afterRepairs: scanAccuracy(afterRepairs, corrected) } : {}),
  };
}

const percent = (right: number, of: number) => (of ? Math.round((right / of) * 100) : 0);

/** The result in a few sentences (also to copy into a bug report). */
export function describeAccuracy(result: { scan: AccuracyResult; afterRepairs?: AccuracyResult }): string[] {
  const { scan, afterRepairs } = result;
  if (!scan.notes) return ["The score has no notes to compare yet."];
  const lines = [`The scan had ${scan.right} of the ${scan.notes} notes right (${percent(scan.right, scan.notes)}%).`];
  if (scan.wrong) lines.push(`${scan.wrong} of its notes were wrong or extra.`);
  if (afterRepairs) lines.push(`After the automatic corrections: ${afterRepairs.right} of ${afterRepairs.notes} (${percent(afterRepairs.right, afterRepairs.notes)}%).`);
  for (const [group, counts] of Object.entries(scan.groups)) {
    if (group === "added" || !counts.notes) continue;
    lines.push(`Lines read by ${group}: ${counts.right} of ${counts.notes} right (${percent(counts.right, counts.notes)}%).`);
  }
  const added = scan.groups.added;
  if (added?.notes) lines.push(`${added.notes} notes are in bars added since the scan.`);
  lines.push(`${scan.changedBars} bar${scan.changedBars === 1 ? "" : "s"} changed since the scan.`);
  if (percent(scan.right, scan.notes) < 40) {
    lines.push("That is so few that the score was probably transposed or rearranged since: this comparison says little then.");
  }
  return lines;
}
