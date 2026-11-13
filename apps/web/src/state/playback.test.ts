import { newScore } from "@musicraft/score-core";
import { describe, expect, it } from "vitest";
import { usePlayback } from "./playback";

describe("playback speed", () => {
  it("keeps the place in the music when the speed changes while stopped", () => {
    const score = newScore({ title: "T", parts: [{ instrument: "trumpet-bb" }], measures: 4 });
    const playback = usePlayback.getState();
    playback.load(score);
    const bar3 = usePlayback.getState().performance!.measures[2]!.start;
    playback.seek(bar3);
    playback.setTempo(0.5);
    const slow = usePlayback.getState().performance!;
    expect(slow.measures[2]!.start).toBeCloseTo(bar3 * 2);
    expect(usePlayback.getState().position).toBeCloseTo(slow.measures[2]!.start);
    usePlayback.getState().setTempo(1);
    expect(usePlayback.getState().position).toBeCloseTo(bar3);
  });
});
