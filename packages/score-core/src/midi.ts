import { getInstrument } from "./instruments";
import type { Id, Score } from "./model";
import { buildPerformance } from "./performance";

const PPQ = 480;

function vlq(value: number): number[] {
  let v = Math.max(0, Math.round(value));
  const bytes = [v & 0x7f];
  v >>= 7;
  while (v > 0) {
    bytes.unshift((v & 0x7f) | 0x80);
    v >>= 7;
  }
  return bytes;
}

function text(s: string): number[] {
  return [...new TextEncoder().encode(s)];
}

interface TrackEvent {
  tick: number;
  order: number;
  bytes: number[];
}

function track(events: TrackEvent[]): number[] {
  events.sort((a, b) => a.tick - b.tick || a.order - b.order);
  const data: number[] = [];
  let last = 0;
  for (const e of events) {
    data.push(...vlq(e.tick - last), ...e.bytes);
    last = e.tick;
  }
  data.push(0x00, 0xff, 0x2f, 0x00); // end of track
  const length = data.length;
  return [0x4d, 0x54, 0x72, 0x6b, (length >>> 24) & 0xff, (length >>> 16) & 0xff, (length >>> 8) & 0xff, length & 0xff, ...data];
}

function meta(type: number, payload: number[]): number[] {
  return [0xff, type, ...vlq(payload.length), ...payload];
}

/** A Standard MIDI File (type 1): a tempo track plus one track per part, at sounding pitch. */
export function exportMidi(score: Score, options: { partIds?: Id[]; expandRepeats?: boolean } = {}): Uint8Array {
  const perf = buildPerformance(score, { partIds: options.partIds, expandRepeats: options.expandRepeats ?? true });
  const toTick = (whole: number) => Math.round(whole * 4 * PPQ);

  const conductor: TrackEvent[] = [{ tick: 0, order: 0, bytes: meta(0x03, text(score.meta.title || "Musicraft")) }];
  for (const t of perf.tempos) {
    const microseconds = Math.round(60_000_000 / t.quarterBpm);
    conductor.push({
      tick: toTick(t.startWhole),
      order: 1,
      bytes: meta(0x51, [(microseconds >> 16) & 0xff, (microseconds >> 8) & 0xff, microseconds & 0xff]),
    });
  }
  for (const ts of perf.timeSignatures) {
    conductor.push({
      tick: toTick(ts.startWhole),
      order: 1,
      bytes: meta(0x58, [ts.beats, Math.round(Math.log2(ts.beatType)), 24, 8]),
    });
  }

  const tracks: number[][] = [track(conductor)];
  const parts = score.parts.filter((p) => !options.partIds || options.partIds.includes(p.id));
  parts.forEach((part, i) => {
    const channel = i >= 9 ? (i + 1) % 16 : i; // skip channel 10 (index 9), reserved for drums
    const instrument = getInstrument(part.instrument);
    const events: TrackEvent[] = [
      { tick: 0, order: 0, bytes: meta(0x03, text(part.name)) },
      { tick: 0, order: 1, bytes: [0xc0 | channel, instrument.midiProgram & 0x7f] },
    ];
    for (const note of perf.notes) {
      if (note.partId !== part.id) continue;
      const start = toTick(note.startWhole);
      const end = Math.max(start + 1, toTick(note.startWhole + note.durationWhole));
      events.push({ tick: start, order: 3, bytes: [0x90 | channel, note.midi & 0x7f, note.velocity & 0x7f] });
      events.push({ tick: end, order: 2, bytes: [0x80 | channel, note.midi & 0x7f, 0] });
    }
    tracks.push(track(events));
  });

  const header = [
    0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 1, (tracks.length >> 8) & 0xff, tracks.length & 0xff, (PPQ >> 8) & 0xff, PPQ & 0xff,
  ];
  return new Uint8Array([...header, ...tracks.flat()]);
}
