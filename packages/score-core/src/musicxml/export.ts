import { strToU8, zipSync } from "fflate";
import { durationValue, TYPE_VALUE, type Duration, type NoteType } from "../duration";
import { add, cmp, div, eq, frac, gte, lcm, mul, sub, toNumber, ZERO, type Fraction } from "../fraction";
import { getInstrument } from "../instruments";
import {
  breaksRestAfter,
  breaksRestBefore,
  concertKeys,
  eventOnsets,
  eventValue,
  measureIsEmpty,
  measureLengths,
  timeSignatures,
  voiceLength,
  type Clef,
  type Direction,
  type Id,
  type MusicEvent,
  type NoteEvent,
  type Part,
  type PartMeasure,
  type Score,
  type TimeSignature,
  type Voice,
} from "../model";
import { keyAlterations, UNISON, type Pitch } from "../pitch";
import { toWrittenPitch, writtenContexts, type WrittenContext } from "../transpose";
import { escapeXml } from "./dom";

export interface ExportOptions {
  /** Written pitch (transposed parts, the default) or concert pitch for every part. */
  pitch?: "written" | "concert";
  /** Export only these parts (part extraction). */
  partIds?: Id[];
  /** Put element ids on notes, rests and measures (needed to map the rendered page back). Default true. */
  includeIds?: boolean;
  /** Combine runs of empty bars into multi-bar rests (for printed parts). */
  multiRests?: boolean;
}

const ACCIDENTAL_NAMES: Record<number, string> = {
  [-2]: "flat-flat",
  [-1]: "flat",
  0: "natural",
  1: "sharp",
  2: "double-sharp",
};

const DYNAMIC_PLACEMENT = "below";

const BAR_STYLE_XML: Record<string, string> = {
  double: "light-light",
  final: "light-heavy",
  dashed: "dashed",
  heavy: "heavy",
};

export function exportMusicXml(score: Score, options: ExportOptions = {}): string {
  return new Exporter(score, options).run();
}

/** Compressed MusicXML (.mxl). */
export function exportMxl(score: Score, options: ExportOptions = {}): Uint8Array {
  const xml = exportMusicXml(score, options);
  const container =
    '<?xml version="1.0" encoding="UTF-8"?>\n<container><rootfiles>' +
    '<rootfile full-path="score.musicxml" media-type="application/vnd.recordare.musicxml+xml"/>' +
    "</rootfiles></container>\n";
  return zipSync(
    {
      mimetype: [strToU8("application/vnd.recordare.musicxml"), { level: 0 }],
      "META-INF/container.xml": strToU8(container),
      "score.musicxml": strToU8(xml),
    },
    { level: 6 },
  );
}

// ---------------------------------------------------------------------------
// Beams and tuplets (exported for tests)
// ---------------------------------------------------------------------------

/** Length of a beam group: a beat in simple time, a dotted beat in compound time, half a bar in 2/2. */
export function beamGroupLength(time: TimeSignature): Fraction {
  if (time.beatType >= 8 && time.beats % 3 === 0 && time.beats > 3) return frac(3, time.beatType);
  if (time.beatType === 2) return frac(1, 2);
  return frac(1, time.beatType);
}

function beamLevels(d: Duration): number {
  const value = TYPE_VALUE[d.type];
  // eighth = 1, 16th = 2, 32nd = 3 …
  let levels = 0;
  let v = frac(1, 8);
  while (gte(v, value) && levels < 7) {
    levels++;
    v = mul(v, frac(1, 2));
  }
  return levels;
}

export type BeamValue = "begin" | "continue" | "end" | "forward hook" | "backward hook";

/** Tuplet groups as [firstIndex, lastIndex] pairs over the voice's events. */
export function tupletGroups(events: MusicEvent[]): [number, number][] {
  const groups: [number, number][] = [];
  let i = 0;
  while (i < events.length) {
    const e = events[i]!;
    const t = e.duration.tuplet;
    if (!t || (e.kind === "note" && e.grace)) {
      i++;
      continue;
    }
    // The run of consecutive events with the same ratio.
    let j = i;
    while (
      j + 1 < events.length &&
      events[j + 1]!.duration.tuplet?.actual === t.actual &&
      events[j + 1]!.duration.tuplet?.normal === t.normal
    ) {
      j++;
    }
    const run = events.slice(i, j + 1);
    const nominal = run.map((ev) => durationValue({ ...ev.duration, tuplet: undefined }));
    // Largest note value whose groups (actual × unit) tile the run exactly.
    const units = [...new Set(run.map((ev) => ev.duration.type))]
      .map((type) => TYPE_VALUE[type as NoteType])
      .sort((a, b) => cmp(b, a));
    let placed = false;
    for (const unit of units) {
      const target = mul(unit, frac(t.actual));
      const split: [number, number][] = [];
      let acc = ZERO;
      let start = 0;
      let ok = true;
      nominal.forEach((v, k) => {
        acc = add(acc, v);
        if (eq(acc, target)) {
          split.push([i + start, i + k]);
          start = k + 1;
          acc = ZERO;
        } else if (cmp(acc, target) > 0) ok = false;
      });
      if (ok && start === run.length) {
        groups.push(...split);
        placed = true;
        break;
      }
    }
    if (!placed) groups.push([i, j]);
    i = j + 1;
  }
  return groups;
}

/** Beam values per event index (level 1 first). */
export function computeBeams(events: MusicEvent[], onsets: Fraction[], groupLength: Fraction): Map<number, BeamValue[]> {
  const result = new Map<number, BeamValue[]>();
  const tuplets = tupletGroups(events);
  const tupletOf = (index: number) => tuplets.findIndex(([a, b]) => index >= a && index <= b);
  const beamable = (e: MusicEvent) => e.kind === "note" && !e.grace && beamLevels(e.duration) > 0;
  const groupKey = (index: number) => {
    const t = tupletOf(index);
    return t >= 0 ? `t${t}` : `b${Math.floor(toNumber(div(onsets[index]!, groupLength)) + 1e-9)}`;
  };

  let run: number[] = [];
  const flush = () => {
    if (run.length >= 2) {
      const levels = run.map((i) => beamLevels(events[i]!.duration));
      const maxLevel = Math.max(...levels);
      for (let level = 1; level <= maxLevel; level++) {
        let k = 0;
        while (k < run.length) {
          if (levels[k]! < level) {
            k++;
            continue;
          }
          let end = k;
          while (end + 1 < run.length && levels[end + 1]! >= level) end++;
          for (let x = k; x <= end; x++) {
            const values = result.get(run[x]!) ?? [];
            if (end === k) values.push(level === 1 ? "begin" : k === run.length - 1 ? "backward hook" : "forward hook");
            else values.push(x === k ? "begin" : x === end ? "end" : "continue");
            result.set(run[x]!, values);
          }
          k = end + 1;
        }
      }
    }
    run = [];
  };

  events.forEach((e, index) => {
    if (e.kind === "note" && e.grace) return;
    if (!beamable(e)) {
      flush();
      return;
    }
    if (run.length > 0 && groupKey(run[run.length - 1]!) !== groupKey(index)) flush();
    run.push(index);
  });
  flush();
  return result;
}

// ---------------------------------------------------------------------------
// Exporter
// ---------------------------------------------------------------------------

class Exporter {
  private out: string[] = [];
  private divisions = 1;
  private readonly includeIds: boolean;
  private readonly lengths: Fraction[];
  private readonly times: TimeSignature[];

  constructor(
    private score: Score,
    private options: ExportOptions,
  ) {
    this.includeIds = options.includeIds ?? true;
    this.lengths = measureLengths(score);
    this.times = timeSignatures(score);
  }

  private w(line: string) {
    this.out.push(line);
  }

  private dur(value: Fraction): number {
    return Math.round(toNumber(mul(value, frac(4 * this.divisions))));
  }

  run(): string {
    const parts = this.options.partIds
      ? this.score.parts.filter((p) => this.options.partIds!.includes(p.id))
      : this.score.parts;
    this.divisions = this.computeDivisions(parts);

    this.w('<?xml version="1.0" encoding="UTF-8" standalone="no"?>');
    this.w(
      '<!DOCTYPE score-partwise PUBLIC "-//Recordare//DTD MusicXML 4.0 Partwise//EN" "http://www.musicxml.org/dtds/partwise.dtd">',
    );
    this.w('<score-partwise version="4.0">');
    this.writeHeader();
    this.w("<part-list>");
    parts.forEach((part, i) => this.writeScorePart(part, i));
    this.w("</part-list>");
    parts.forEach((part, i) => this.writePart(part, i === 0));
    this.w("</score-partwise>");
    return this.out.join("\n") + "\n";
  }

  private computeDivisions(parts: Part[]): number {
    let d = 1;
    const consider = (value: Fraction) => {
      const quarters = mul(value, frac(4));
      d = lcm(d, quarters.d);
    };
    for (const len of this.lengths) consider(len);
    for (const part of parts) {
      part.measures.forEach((pm, m) => {
        for (const voice of pm.voices) {
          for (const onset of eventOnsets(voice, this.lengths[m]!)) consider(onset);
          for (const e of voice.events) consider(eventValue(e, this.lengths[m]!));
        }
        for (const dir of pm.directions ?? []) consider(dir.offset);
        for (const c of pm.clefChanges ?? []) consider(c.offset);
      });
    }
    return d > 100_000 ? 960 : d;
  }

  private writeHeader() {
    const meta = this.score.meta;
    this.w(`<work><work-title>${escapeXml(meta.title || "Untitled")}</work-title></work>`);
    if (meta.subtitle) this.w(`<movement-title>${escapeXml(meta.subtitle)}</movement-title>`);
    this.w("<identification>");
    if (meta.composer) this.w(`<creator type="composer">${escapeXml(meta.composer)}</creator>`);
    if (meta.arranger) this.w(`<creator type="arranger">${escapeXml(meta.arranger)}</creator>`);
    if (meta.lyricist) this.w(`<creator type="lyricist">${escapeXml(meta.lyricist)}</creator>`);
    if (meta.copyright) this.w(`<rights>${escapeXml(meta.copyright)}</rights>`);
    this.w(
      `<encoding><software>Musicraft</software><encoding-date>${new Date().toISOString().slice(0, 10)}</encoding-date></encoding>`,
    );
    this.w("</identification>");
  }

  private writeScorePart(part: Part, index: number) {
    const instrument = getInstrument(part.instrument);
    // Avoid channel 10 (index 9), which General MIDI reserves for drums.
    const channel = (index % 15) + 1 >= 10 ? (index % 15) + 2 : (index % 15) + 1;
    this.w(`<score-part id="${part.id}">`);
    this.w(`<part-name>${escapeXml(part.name)}</part-name>`);
    if (part.abbreviation) this.w(`<part-abbreviation>${escapeXml(part.abbreviation)}</part-abbreviation>`);
    this.w(`<score-instrument id="${part.id}-I1"><instrument-name>${escapeXml(instrument.name)}</instrument-name>`);
    if (instrument.sound) this.w(`<instrument-sound>${instrument.sound}</instrument-sound>`);
    this.w("</score-instrument>");
    this.w(
      `<midi-instrument id="${part.id}-I1"><midi-channel>${channel}</midi-channel>` +
        `<midi-program>${instrument.midiProgram + 1}</midi-program><volume>80</volume></midi-instrument>`,
    );
    this.w("</score-part>");
  }

  private writePart(part: Part, isFirstPart: boolean) {
    const written = (this.options.pitch ?? "written") === "written";
    const instrument = getInstrument(part.instrument);
    const contexts: WrittenContext[] = written
      ? writtenContexts(this.score, part)
      : concertKeys(this.score).map((key) => ({ key, interval: UNISON }));
    const multiRests = this.options.multiRests ? this.multiRestRuns(part) : new Map<number, number>();

    this.w(`<part id="${part.id}">`);
    this.score.measures.forEach((info, m) => {
      const pm = part.measures[m] ?? { voices: [] };
      const idAttr = this.includeIds && isFirstPart ? ` id="${info.id}"` : "";
      this.w(`<measure number="${escapeXml(info.number)}"${idAttr}${info.implicit ? ' implicit="yes"' : ""}>`);

      // Left barline: start repeat and/or ending start.
      if (info.repeatStart || info.ending?.start) {
        let bl = '<barline location="left">';
        if (info.repeatStart) bl += "<bar-style>heavy-light</bar-style>";
        if (info.ending?.start) bl += `<ending number="${escapeXml(info.ending.number)}" type="start"/>`;
        if (info.repeatStart) bl += '<repeat direction="forward"/>';
        this.w(bl + "</barline>");
      }

      // Attributes at the start of the bar.
      const attrs: string[] = [];
      if (m === 0) attrs.push(`<divisions>${this.divisions}</divisions>`);
      if (m === 0 || info.key) {
        const key = contexts[m]!.key;
        attrs.push(`<key><fifths>${key.fifths}</fifths>${key.mode ? `<mode>${key.mode}</mode>` : ""}</key>`);
      }
      if (m === 0 || info.time) {
        const t = this.times[m]!;
        attrs.push(
          `<time${t.symbol ? ` symbol="${t.symbol}"` : ""}><beats>${t.beats}</beats><beat-type>${t.beatType}</beat-type></time>`,
        );
      }
      if (m === 0 && part.staves > 1) attrs.push(`<staves>${part.staves}</staves>`);
      if (m === 0) part.clefs.forEach((c, s) => attrs.push(clefXml(c, s + 1, part.staves)));
      for (const change of pm.clefChanges ?? []) {
        if (cmp(change.offset, ZERO) === 0) attrs.push(clefXml(change.clef, change.staff, part.staves));
      }
      if (m === 0 && written) {
        const t = instrument.transposition;
        if (t.diatonic !== 0 || t.chromatic !== 0) {
          const octaves = Math.trunc(t.diatonic / 7);
          attrs.push(
            `<transpose><diatonic>${t.diatonic - 7 * octaves}</diatonic><chromatic>${t.chromatic - 12 * octaves}</chromatic>` +
              `${octaves ? `<octave-change>${octaves}</octave-change>` : ""}</transpose>`,
          );
        }
      }
      const restCount = multiRests.get(m);
      if (restCount) attrs.push(`<measure-style><multiple-rest>${restCount}</multiple-rest></measure-style>`);
      if (attrs.length) this.w(`<attributes>${attrs.join("")}</attributes>`);

      // Tempo and rehearsal marks belong to the top part only.
      if (isFirstPart || this.options.partIds) {
        if (info.rehearsal) {
          this.w(
            `<direction placement="above"><direction-type><rehearsal>${escapeXml(info.rehearsal)}</rehearsal></direction-type></direction>`,
          );
        }
        if (info.tempo) {
          const t = info.tempo;
          const quarterBpm = toNumber(
            mul(frac(t.bpm), div(durationValue({ type: t.beatUnit, dots: t.beatUnitDots ?? 0 }), frac(1, 4))),
          );
          let xml = '<direction placement="above">';
          if (t.text) xml += `<direction-type><words font-weight="bold">${escapeXml(t.text)}</words></direction-type>`;
          xml +=
            `<direction-type><metronome parentheses="no"><beat-unit>${t.beatUnit}</beat-unit>` +
            "<beat-unit-dot/>".repeat(t.beatUnitDots ?? 0) +
            `<per-minute>${t.bpm}</per-minute></metronome></direction-type>`;
          xml += `<sound tempo="${Math.round(quarterBpm * 100) / 100}"/></direction>`;
          this.w(xml);
        }
      }

      this.writeVoices(part, pm, m, contexts[m]!);

      // Right barline.
      const isLast = m === this.score.measures.length - 1;
      let barStyle = info.barline && info.barline !== "regular" ? BAR_STYLE_XML[info.barline] : undefined;
      if (info.repeatEnd || (!barStyle && isLast)) barStyle = "light-heavy";
      if (barStyle || info.ending?.stop) {
        let bl = '<barline location="right">';
        if (barStyle) bl += `<bar-style>${barStyle}</bar-style>`;
        if (info.ending?.stop) {
          bl += `<ending number="${escapeXml(info.ending.number)}" type="${info.ending.open ? "discontinue" : "stop"}"/>`;
        }
        if (info.repeatEnd) {
          bl += `<repeat direction="backward"${info.repeatEnd.times && info.repeatEnd.times !== 2 ? ` times="${info.repeatEnd.times}"` : ""}/>`;
        }
        this.w(bl + "</barline>");
      }
      this.w("</measure>");
    });
    this.w("</part>");
  }

  /** First bar of each run of empty bars → run length. Runs break wherever something is printed. */
  private multiRestRuns(part: Part): Map<number, number> {
    const runs = new Map<number, number>();
    let start = -1;
    const close = (endExclusive: number) => {
      if (start >= 0 && endExclusive - start >= 2) runs.set(start, endExclusive - start);
      start = -1;
    };
    this.score.measures.forEach((info, m) => {
      const pm = part.measures[m];
      const empty = measureIsEmpty(pm) && !pm?.clefChanges?.length && !pm?.directions?.length;
      // Anything printed at the start of this bar ends the run before it, and no run goes under a volta.
      if (breaksRestBefore(info) || info.ending || !empty) close(m);
      if (empty && start < 0) start = m;
      // Anything printed at the end of this bar ends the run after it.
      if (breaksRestAfter(info)) close(m + 1);
    });
    close(this.score.measures.length);
    return runs;
  }

  private writeVoices(part: Part, pm: PartMeasure, m: number, ctx: WrittenContext) {
    const length = this.lengths[m]!;
    const voices = [...pm.voices].sort((a, b) => a.staff - b.staff || a.voice - b.voice);
    const accidentals = this.computeAccidentals(voices, length, ctx);
    let previousLength: Fraction | undefined;
    const firstVoiceOfStaff = new Set<number>();

    voices.forEach((voice) => {
      if (previousLength && cmp(previousLength, ZERO) > 0) {
        this.w(`<backup><duration>${this.dur(previousLength)}</duration></backup>`);
      }
      const markers = firstVoiceOfStaff.has(voice.staff) ? [] : this.markersFor(pm, voice.staff);
      firstVoiceOfStaff.add(voice.staff);
      const localIndex = voices.filter((v) => v.staff === voice.staff).indexOf(voice);
      const voiceNumber = (voice.staff - 1) * 4 + localIndex + 1;
      this.writeVoice(part, voice, voiceNumber, length, m, ctx, markers, accidentals);
      previousLength = voiceLength(voice, length);
    });
  }

  private markersFor(pm: PartMeasure, staff: number): { offset: Fraction; xml: string }[] {
    const markers: { offset: Fraction; xml: string }[] = [];
    for (const d of pm.directions ?? []) {
      if (d.staff !== staff) continue;
      markers.push({ offset: d.offset, xml: directionXml(d, staff) });
    }
    for (const c of pm.clefChanges ?? []) {
      if (c.staff !== staff || cmp(c.offset, ZERO) === 0) continue;
      markers.push({ offset: c.offset, xml: `<attributes>${clefXml(c.clef, c.staff, 2)}</attributes>` });
    }
    return markers.sort((a, b) => cmp(a.offset, b.offset));
  }

  private computeAccidentals(voices: Voice[], length: Fraction, ctx: WrittenContext): Map<string, string> {
    const shown = new Map<string, string>();
    const keyAlter = keyAlterations(ctx.key.fifths);
    const staves = new Set(voices.map((v) => v.staff));
    for (const staff of staves) {
      const items: { onset: Fraction; noteId: string; pitch: Pitch; tieStop: boolean; grace: boolean }[] = [];
      for (const voice of voices.filter((v) => v.staff === staff)) {
        const onsets = eventOnsets(voice, length);
        voice.events.forEach((e, i) => {
          if (e.kind !== "note") return;
          for (const n of e.notes) {
            items.push({
              onset: onsets[i]!,
              noteId: n.id,
              pitch: toWrittenPitch(n.pitch, ctx),
              tieStop: !!n.tie?.stop,
              grace: !!e.grace,
            });
          }
        });
      }
      items.sort((a, b) => cmp(a.onset, b.onset) || (a.grace === b.grace ? 0 : a.grace ? -1 : 1));
      const state = new Map<string, number>();
      for (const item of items) {
        if (item.tieStop) continue;
        const key = `${item.pitch.step}${item.pitch.octave}`;
        const current = state.get(key) ?? keyAlter[item.pitch.step];
        if (item.pitch.alter !== current) {
          const name = ACCIDENTAL_NAMES[item.pitch.alter];
          if (name) shown.set(item.noteId, name);
          state.set(key, item.pitch.alter);
        }
      }
    }
    return shown;
  }

  private writeVoice(
    part: Part,
    voice: Voice,
    voiceNumber: number,
    length: Fraction,
    m: number,
    ctx: WrittenContext,
    markers: { offset: Fraction; xml: string }[],
    accidentals: Map<string, string>,
  ) {
    const onsets = eventOnsets(voice, length);
    const beams = computeBeams(voice.events, onsets, beamGroupLength(this.times[m]!));
    const tuplets = tupletGroups(voice.events);
    const tupletStart = new Map(tuplets.map(([a, b]) => [a, b]));
    const tupletStop = new Set(tuplets.map(([, b]) => b));
    const staffXml = part.staves > 1 ? `<staff>${voice.staff}</staff>` : "";
    let markerIndex = 0;

    const flushMarkers = (upTo: Fraction, position: Fraction) => {
      while (markerIndex < markers.length && cmp(markers[markerIndex]!.offset, upTo) <= 0) {
        const marker = markers[markerIndex++]!;
        const offset = sub(marker.offset, position);
        this.w(cmp(offset, ZERO) === 0 ? marker.xml : withOffset(marker.xml, this.dur(offset)));
      }
    };

    voice.events.forEach((event, i) => {
      flushMarkers(onsets[i]!, onsets[i]!);
      const value = eventValue(event, length);
      if (event.kind === "rest") {
        const id = this.includeIds ? ` id="${event.id}"` : "";
        const hidden = event.hidden ? ' print-object="no"' : "";
        let xml = `<note${id}${hidden}>`;
        xml += event.measureRest ? '<rest measure="yes"/>' : "<rest/>";
        xml += `<duration>${this.dur(value)}</duration><voice>${voiceNumber}</voice>`;
        if (!event.measureRest) xml += durationXml(event.duration);
        xml += timeModXml(event.duration) + staffXml;
        const tupletXml = this.tupletXml(i, tupletStart, tupletStop, voice.events, beams);
        if (tupletXml) xml += `<notations>${tupletXml}</notations>`;
        this.w(xml + "</note>");
        return;
      }
      event.notes.forEach((note, k) => {
        const p = toWrittenPitch(note.pitch, ctx);
        const id = this.includeIds ? ` id="${note.id}"` : "";
        let xml = `<note${id}>`;
        if (event.grace) xml += event.grace.slash ? '<grace slash="yes"/>' : "<grace/>";
        if (k > 0) xml += "<chord/>";
        xml += `<pitch><step>${p.step}</step>${p.alter ? `<alter>${p.alter}</alter>` : ""}<octave>${p.octave}</octave></pitch>`;
        if (!event.grace) xml += `<duration>${this.dur(value)}</duration>`;
        if (note.tie?.stop) xml += '<tie type="stop"/>';
        if (note.tie?.start) xml += '<tie type="start"/>';
        xml += `<voice>${voiceNumber}</voice>${durationXml(event.duration)}`;
        const acc = accidentals.get(note.id);
        if (acc) xml += `<accidental>${acc}</accidental>`;
        xml += timeModXml(event.duration) + staffXml;
        if (k === 0) {
          (beams.get(i) ?? []).forEach((value, level) => {
            xml += `<beam number="${level + 1}">${value}</beam>`;
          });
        }
        const notations = this.notationsXml(event, note.tie, k === 0, i, tupletStart, tupletStop, voice.events, beams);
        if (notations) xml += `<notations>${notations}</notations>`;
        this.w(xml + "</note>");
      });
    });
    flushMarkers(length, voiceLength(voice, length));
  }

  private tupletXml(
    index: number,
    starts: Map<number, number>,
    stops: Set<number>,
    events: MusicEvent[],
    beams: Map<number, BeamValue[]>,
  ): string {
    let xml = "";
    const end = starts.get(index);
    if (end !== undefined) {
      const allBeamed = events.slice(index, end + 1).every((_, k) => beams.has(index + k));
      xml += `<tuplet type="start" bracket="${allBeamed ? "no" : "yes"}"/>`;
    }
    if (stops.has(index)) xml += '<tuplet type="stop"/>';
    return xml;
  }

  private notationsXml(
    event: NoteEvent,
    tie: { start?: boolean; stop?: boolean } | undefined,
    firstOfChord: boolean,
    index: number,
    starts: Map<number, number>,
    stops: Set<number>,
    events: MusicEvent[],
    beams: Map<number, BeamValue[]>,
  ): string {
    let xml = "";
    if (tie?.stop) xml += '<tied type="stop"/>';
    if (tie?.start) xml += '<tied type="start"/>';
    if (!firstOfChord) return xml;
    for (const slur of event.slurs ?? []) xml += `<slur type="${slur.type}" number="${slur.number ?? 1}"/>`;
    xml += this.tupletXml(index, starts, stops, events, beams);
    const arts = event.articulations ?? [];
    const articulationXml = arts
      .map((a) =>
        a === "accent"
          ? "<accent/>"
          : a === "marcato"
            ? '<strong-accent type="up"/>'
            : a === "staccato"
              ? "<staccato/>"
              : a === "staccatissimo"
                ? "<staccatissimo/>"
                : a === "tenuto"
                  ? "<tenuto/>"
                  : a === "breath"
                    ? "<breath-mark/>"
                    : "",
      )
      .join("");
    if (articulationXml) xml += `<articulations>${articulationXml}</articulations>`;
    if (arts.includes("fermata")) xml += '<fermata type="upright"/>';
    const ornaments = arts
      .map((a) => (a === "trill" ? "<trill-mark/>" : a === "mordent" ? "<mordent/>" : a === "turn" ? "<turn/>" : ""))
      .join("");
    if (ornaments) xml += `<ornaments>${ornaments}</ornaments>`;
    return xml;
  }
}

function durationXml(d: Duration): string {
  return `<type>${d.type}</type>` + "<dot/>".repeat(d.dots);
}

function timeModXml(d: Duration): string {
  if (!d.tuplet) return "";
  return `<time-modification><actual-notes>${d.tuplet.actual}</actual-notes><normal-notes>${d.tuplet.normal}</normal-notes></time-modification>`;
}

function clefXml(c: Clef, staff: number, staves: number): string {
  const number = staves > 1 ? ` number="${staff}"` : "";
  const octave = c.octaveChange ? `<clef-octave-change>${c.octaveChange}</clef-octave-change>` : "";
  return `<clef${number}><sign>${c.sign}</sign><line>${c.line}</line>${octave}</clef>`;
}

function directionXml(d: Direction, staff: number): string {
  const staffXml = `<staff>${staff}</staff>`;
  switch (d.kind) {
    case "dynamic":
      return `<direction placement="${DYNAMIC_PLACEMENT}"><direction-type><dynamics><${d.value}/></dynamics></direction-type>${staffXml}</direction>`;
    case "words":
      return `<direction placement="${d.placement ?? "above"}"><direction-type><words>${escapeXml(d.text)}</words></direction-type>${staffXml}</direction>`;
    case "wedge":
      return `<direction placement="below"><direction-type><wedge type="${d.type}"/></direction-type>${staffXml}</direction>`;
  }
}

function withOffset(directionXmlText: string, offsetDivs: number): string {
  if (!directionXmlText.startsWith("<direction")) return directionXmlText;
  return directionXmlText.replace(/(<staff>\d+<\/staff>)?<\/direction>$/, (_m, staff: string | undefined) =>
    `<offset>${offsetDivs}</offset>${staff ?? ""}</direction>`,
  );
}
