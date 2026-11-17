import { describe, expect, it } from "vitest";
import { encodeWav } from "./render";

/** A two-channel buffer, as an AudioBuffer has it. */
function buffer(left: number[], right: number[]): AudioBuffer {
  const channels = [Float32Array.from(left), Float32Array.from(right)];
  return { numberOfChannels: 2, length: left.length, sampleRate: 44100, getChannelData: (c: number) => channels[c]! } as unknown as AudioBuffer;
}

async function bytesOf(blob: Blob): Promise<DataView> {
  return new DataView(await blob.arrayBuffer());
}

describe("WAV files", () => {
  it("writes 16-bit stereo PCM with a correct header", async () => {
    const view = await bytesOf(encodeWav(buffer([0, 0.5, -0.5], [0.25, 0, 0])));
    const text = (at: number, length: number) => String.fromCharCode(...Array.from({ length }, (_, i) => view.getUint8(at + i)));
    expect(text(0, 4)).toBe("RIFF");
    expect(text(8, 4)).toBe("WAVE");
    expect(view.getUint16(22, true)).toBe(2);
    expect(view.getUint32(24, true)).toBe(44100);
    expect(view.getUint16(34, true)).toBe(16);
    expect(view.getUint32(40, true)).toBe(3 * 2 * 2);
    expect(view.byteLength).toBe(44 + 12);
    // Interleaved: left, right, left, right…
    expect([0, 1, 2, 3, 4, 5].map((i) => view.getInt16(44 + i * 2, true))).toEqual([0, 8192, 16384, 0, -16383, 0]);
  });

  it("turns the sound down rather than clip it", async () => {
    const view = await bytesOf(encodeWav(buffer([2, -1], [1, 0])));
    expect(view.getInt16(44, true)).toBe(Math.round(0.99 * 32767));
    expect(view.getInt16(48, true)).toBe(Math.round(-0.495 * 32767));
  });
});
