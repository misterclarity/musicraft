import { SCORE_TOOLS } from "@musicraft/score-core";
import { describe, expect, it } from "vitest";
import { TOOL_LABELS } from "./labels";

describe("tool labels", () => {
  it("has a readable label for every tool the assistant can call", () => {
    const names = [...SCORE_TOOLS.map((t) => t.name), "look_at_page"];
    expect(names.filter((name) => !TOOL_LABELS[name])).toEqual([]);
  });
});
