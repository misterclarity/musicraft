import { unzipSync } from "fflate";
import {
  durationFromValue,
  durationValue,
  exactDuration,
  NOTE_TYPES,
  splitValue,
  type Duration,
  type NoteType,
} from "../duration";
import { add, cmp, div, frac, gt, lt, sub, sum, toNumber, ZERO, type Fraction } from "../fraction";
import { newId } from "../ids";
import {
  DEFAULT_INSTRUMENT_ID,
  getInstrument,
  hasInstrument,
  INSTRUMENTS,
  instrumentForSound,
  matchInstrument,
  type InstrumentDef,
} from "../instruments";
import {
  DYNAMICS,
  measureLengths,
  SCORE_SCHEMA_VERSION,
  voiceLength,
  type Articulation,
  type BarlineStyle,
  type Clef,
  type ClefSign,
  type Direction,
  type Dynamic,
  type MeasureInfo,
  type MusicEvent,
  type Note,
  type NoteEvent,
  type Part,
  type PartMeasure,
  type Score,
  type SlurMark,
  type Tempo,
  type Voice,
} from "../model";
import {
  intervalFifths,
  isUnison,
  midiNumber,
  transposeKey,
  transposePitch,
  type Interval,
  type KeySignature,
  type Step,
} from "../pitch";
import {
  child,
  childComments,
  childNumber,
  childText,
  decodeXmlBytes,
  elements,
  parseXml,
  type XmlParser,
} from "./dom";

export interface ImportOptions {
  parser?: XmlParser;
  /**
   * Instrument per part (by index). When given, the part's pitches are read as WRITTEN for that
   * instrument even without a <transpose> element — used for recognised (OMR) pages.
   */
  instruments?: (string | undefined)[];
  /**
   * Treat a short first bar (and short bars around repeats) as intentional. Default true; turn it off
   * for recognised pages, where a short bar is more likely a recognition error.
   */
  detectPickups?: boolean;
  /**
   * Place each note right after the previous note of its voice, using the file's time position only
   * for a voice's first note in a bar. Recognition engines sometimes omit the <backup> elements
   * between staves; this keeps their rhythms intact.
   */
  sequentialVoices?: boolean;
}

export interface ImportResult {
  score: Score;
  warnings: string[];
  /** Approximate position of notes on the source image (homr writes them as comments), by event id. */
  imagePositions: Record<string, { x: number; y: number }>;
  /** Measure indexes where a new system (line of music) starts in the source, from <print new-system>. */
  systemStarts: number[];
}

/** Import a MusicXML document (partwise). */
export function importMusicXml(text: string, options: ImportOptions = {}): ImportResult {
  const root = parseXml(text, options.parser);
  if (root.nodeName === "score-timewise") {
    throw new Error("Timewise MusicXML is not supported. Re-export the file as partwise MusicXML.");
  }
  if (root.nodeName !== "score-partwise") {
    throw new Error(`Not a MusicXML score (root element <${root.nodeName}>).`);
  }
  return new Importer(root, options).run();
}

/** Import a compressed MusicXML file (.mxl). */
export function importMxl(bytes: Uint8Array, options: ImportOptions = {}): ImportResult {
  const files = unzipSync(bytes);
  let rootPath: string | undefined;
  const container = files["META-INF/container.xml"];
  if (container) {
    const match = /full-path="([^"]+)"/.exec(decodeXmlBytes(container));
    rootPath = match?.[1];
  }
  rootPath ??= Object.keys(files).find((name) => /\.(musicxml|xml)$/i.test(name) && !name.startsWith("META-INF/"));
  const data = rootPath ? files[rootPath] : undefined;
  if (!data) throw new Error("The .mxl archive contains no MusicXML score.");
  return importMusicXml(decodeXmlBytes(data), options);
}

/** Import .musicxml/.xml text or .mxl bytes, detected from the content. */
export function importMusicFile(data: Uint8Array, options: ImportOptions = {}): ImportResult {
  if (data[0] === 0x50 && data[1] === 0x4b) return importMxl(data, options); // "PK" zip header
  return importMusicXml(decodeXmlBytes(data), options);
}

const ARTICULATION_MAP: Record<string, Articulation[]> = {
  accent: ["accent"],
  "strong-accent": ["marcato"],
  staccato: ["staccato"],
  staccatissimo: ["staccatissimo"],
  spiccato: ["staccatissimo"],
  tenuto: ["tenuto"],
  "detached-legato": ["tenuto", "staccato"],
  "breath-mark": ["breath"],
};

const ORNAMENT_MAP: Record<string, Articulation> = {
  "trill-mark": "trill",
  mordent: "mordent",
  "inverted-mordent": "mordent",
  turn: "turn",
  "inverted-turn": "turn",
  "delayed-turn": "turn",
};

const BAR_STYLES: Record<string, BarlineStyle> = {
  regular: "regular",
  "light-light": "double",
  "light-heavy": "final",
  heavy: "heavy",
  "heavy-heavy": "heavy",
  dashed: "dashed",
  dotted: "dashed",
};

interface VoiceBuild {
  voice: Voice;
  end: Fraction;
}

class Importer {
  private warnings = new Set<string>();
  private imagePositions: Record<string, { x: number; y: number }> = {};
  private measures: MeasureInfo[] = [];
  private systemStarts = new Set<number>([0]);

  constructor(
    private root: Element,
    private options: ImportOptions,
  ) {}

  /** Bar length of the time signature in force at a measure (as far as it has been read). */
  private timeAt(measureIndex: number): Fraction | undefined {
    for (let i = measureIndex; i >= 0; i--) {
      const time = this.measures[i]?.time;
      if (time) return frac(time.beats, time.beatType);
    }
    return undefined;
  }

  private warn(message: string) {
    this.warnings.add(message);
  }

  run(): ImportResult {
    const score: Score = {
      id: newId("s"),
      schemaVersion: SCORE_SCHEMA_VERSION,
      meta: this.readMeta(),
      measures: this.measures,
      parts: [],
    };

    const partInfo = new Map<string, Element>();
    for (const sp of elements(child(this.root, "part-list"), "score-part")) {
      const id = sp.getAttribute("id");
      if (id) partInfo.set(id, sp);
    }

    const partElements = elements(this.root, "part");
    if (partElements.length === 0) throw new Error("The score has no parts.");
    partElements.forEach((el, index) => {
      score.parts.push(this.readPart(el, partInfo.get(el.getAttribute("id") ?? ""), index));
    });

    // Every part needs one entry per bar.
    for (const part of score.parts) {
      while (part.measures.length < this.measures.length) {
        part.measures.push(emptyMeasureFor(part.staves));
      }
    }

    const first = this.measures[0];
    if (first && !first.time) {
      first.time = { beats: 4, beatType: 4 };
      this.warn("No time signature found at the start; assuming 4/4.");
    }
    if (first && !first.key) first.key = { fifths: 0, mode: "major" };
    if (this.options.detectPickups !== false) markShortMeasures(score);

    return {
      score,
      warnings: [...this.warnings],
      imagePositions: this.imagePositions,
      systemStarts: [...this.systemStarts].filter((m) => m < this.measures.length).sort((a, b) => a - b),
    };
  }

  private readMeta(): Score["meta"] {
    const workTitle = childText(child(this.root, "work"), "work-title");
    const movementTitle = childText(this.root, "movement-title");
    const credits = elements(this.root, "credit");
    const creditOf = (type: string) =>
      credits
        .filter((c) => elements(c, "credit-type").some((t) => t.textContent?.trim() === type))
        .map((c) => childText(c, "credit-words"))
        .find(Boolean);
    const creators = elements(child(this.root, "identification"), "creator");
    const creator = (type: string) =>
      creators.find((c) => c.getAttribute("type") === type)?.textContent?.trim() || undefined;

    const title = workTitle ?? movementTitle ?? creditOf("title") ?? "Untitled";
    const subtitle = (workTitle && movementTitle && movementTitle !== workTitle ? movementTitle : undefined) ??
      creditOf("subtitle");
    return {
      title,
      subtitle,
      composer: creator("composer") ?? creditOf("composer"),
      arranger: creator("arranger") ?? creditOf("arranger"),
      lyricist: creator("lyricist") ?? creator("poet") ?? creditOf("lyricist"),
      copyright: childText(child(this.root, "identification"), "rights") ?? creditOf("rights"),
    };
  }

  private chooseInstrument(
    partIndex: number,
    info: Element | undefined,
    name: string,
    transposition: Interval | undefined,
    staves: number,
    firstClef: ClefSign | undefined,
  ): { instrument: InstrumentDef; override: boolean } {
    const override = this.options.instruments?.[partIndex];
    if (override && hasInstrument(override)) return { instrument: getInstrument(override), override: true };

    const scoreInstrument = child(info, "score-instrument");
    const sound = childText(scoreInstrument, "instrument-sound");
    const instrumentName = childText(scoreInstrument, "instrument-name") ?? "";
    const sameTransposition = (i: InstrumentDef) =>
      !transposition
        ? isUnison(i.transposition)
        : i.transposition.diatonic === transposition.diatonic && i.transposition.chromatic === transposition.chromatic;

    const bySound = sound ? instrumentForSound(sound) : undefined;
    if (bySound && sameTransposition(bySound)) return { instrument: bySound, override: false };
    const byName = matchInstrument(name, transposition) ?? matchInstrument(instrumentName, transposition);
    if (byName && sameTransposition(byName)) return { instrument: byName, override: false };
    if (byName && !transposition) {
      // No <transpose> means the file is at concert pitch; keep the instrument and read the notes as sounding.
      if (!isUnison(byName.transposition)) {
        this.warn(
          `Part "${name}" has no transposition information, so its notes were read as concert pitch. If they are ` +
            `written for ${byName.name}, use "Change instrument" with "keep written notes".`,
        );
      }
      return { instrument: byName, override: false };
    }
    if (byName && transposition) {
      // The name is clear but the file transposes differently (an octave-transposing tenor, a horn in E…).
      // The file's own transposition still converts its notes to concert pitch.
      if (intervalFifths(transposition) !== intervalFifths(byName.transposition)) {
        this.warn(`Part "${name}" uses a transposition Musicraft doesn't have; it is shown as ${byName.name}.`);
      }
      return { instrument: byName, override: false };
    }
    if (transposition && !isUnison(transposition)) {
      const byTransposition = INSTRUMENTS.find((i) => sameTransposition(i) && i.staves === staves);
      if (byTransposition) {
        this.warn(`Couldn't recognise the instrument of part "${name}"; using ${byTransposition.name}.`);
        return { instrument: byTransposition, override: false };
      }
    }
    if (staves >= 2) return { instrument: getInstrument("piano"), override: false };
    if (firstClef === "F") return { instrument: getInstrument("generic-bass"), override: false };
    return { instrument: getInstrument(DEFAULT_INSTRUMENT_ID), override: false };
  }

  private readPart(partEl: Element, info: Element | undefined, partIndex: number): Part {
    const measureEls = elements(partEl, "measure");
    const name = childText(info, "part-name") ?? `Part ${partIndex + 1}`;
    const abbreviation = childText(info, "part-abbreviation");

    // Look ahead at the first attributes for transposition, staves and clef.
    let transposition: Interval | undefined;
    let staves = 1;
    let firstClef: ClefSign | undefined;
    for (const attrs of elements(measureEls[0], "attributes")) {
      const t = child(attrs, "transpose");
      if (t) transposition = readTranspose(t);
      staves = Math.max(staves, childNumber(attrs, "staves") ?? 1);
      firstClef ??= childText(child(attrs, "clef"), "sign") as ClefSign | undefined;
    }

    const { instrument, override } = this.chooseInstrument(partIndex, info, name, transposition, staves, firstClef);
    // Interval from the written notes in the file to concert pitch.
    let writtenToSounding: Interval | undefined = override ? instrument.transposition : transposition;

    const part: Part = {
      id: newId("p"),
      name: override && /^(voice|part \d+|p\d+)$/i.test(name.trim()) ? instrument.name : name,
      abbreviation: abbreviation ?? instrument.abbreviation,
      instrument: instrument.id,
      staves,
      clefs: [],
      measures: [],
    };

    let divisions = 1;
    let noteInterval: Interval = writtenToSounding ?? { diatonic: 0, chromatic: 0 };
    let warnedKeyMismatch = false;

    measureEls.forEach((measureEl, mIndex) => {
      let info = this.measures[mIndex];
      if (!info) {
        info = {
          id: newId("m"),
          number: measureEl.getAttribute("number") ?? String(mIndex + 1),
        };
        if (measureEl.getAttribute("implicit") === "yes") info.implicit = true;
        this.measures.push(info);
      }
      const measureInfo = info;
      const isFirstPart = partIndex === 0;
      const pm: PartMeasure = { voices: [], clefChanges: [], directions: [] };
      const builds = new Map<string, VoiceBuild>();
      let cursor: Fraction = ZERO;
      let lastNote: { event: NoteEvent; staff: number } | undefined;
      const toWhole = (divs: number) => frac(Math.round(divs * 1000), Math.round(divisions * 4 * 1000));

      const voiceAt = (staff: number, voiceNumber: number, onset: Fraction): VoiceBuild => {
        const key = `${staff}/${voiceNumber}`;
        let build = builds.get(key);
        // Files store durations in whole "divisions", so tuplets are often rounded: treat tiny
        // differences between where a voice ends and where the next note starts as continuous.
        if (build && nearlyEqual(build.end, onset)) return build;
        if (build && gt(build.end, onset)) {
          // Overlap (malformed or a voice we can't follow): put the note in a free voice on the staff.
          const free = [...builds.values()].find(
          (b) => b.voice.staff === staff && (!gt(b.end, onset) || nearlyEqual(b.end, onset)),
        );
          if (free) return pad(free, onset);
          const used = [...builds.values()].filter((b) => b.voice.staff === staff).map((b) => b.voice.voice);
          const next = Math.max(voiceNumber, ...used) + 1;
          this.warn(`Overlapping notes in bar ${measureInfo.number} were moved to an extra voice.`);
          return voiceAt(staff, next, onset);
        }
        if (!build) {
          build = { voice: { staff, voice: voiceNumber, events: [] }, end: ZERO };
          builds.set(key, build);
        }
        return pad(build, onset);
      };

      const pad = (build: VoiceBuild, onset: Fraction): VoiceBuild => {
        if (lt(build.end, onset) && !nearlyEqual(build.end, onset)) {
          const gap = sub(onset, build.end);
          const parts = splitValue(gap);
          const exact = cmp(sum(parts.map(durationValue)), gap) === 0 ? parts : [exactDuration(gap)];
          for (const d of exact) build.voice.events.push({ kind: "rest", id: newId("e"), duration: d, hidden: true });
          build.end = onset;
        }
        return build;
      };

      for (const el of elements(measureEl)) {
        switch (el.nodeName) {
          case "attributes": {
            const d = childNumber(el, "divisions");
            if (d && d > 0) divisions = d;
            const t = child(el, "transpose");
            if (t && !override) {
              writtenToSounding = readTranspose(t);
              noteInterval = writtenToSounding;
            }
            const keyEl = child(el, "key");
            const fifths = childNumber(keyEl, "fifths");
            if (keyEl && fifths !== undefined) {
              const mode = childText(keyEl, "mode") === "minor" ? "minor" : "major";
              const written: KeySignature = { fifths, mode };
              const ctx = writtenToSounding && !isUnison(writtenToSounding)
                ? transposeKey(written, writtenToSounding)
                : { key: written, interval: writtenToSounding ?? { diatonic: 0, chromatic: 0 } };
              noteInterval = ctx.interval;
              if (isFirstPart || !measureInfo.key) measureInfo.key = ctx.key;
              else if (measureInfo.key.fifths !== ctx.key.fifths && !warnedKeyMismatch) {
                warnedKeyMismatch = true;
                this.warn(`Part "${part.name}" is in a different key than the first part; the first part's key is used.`);
              }
            }
            const timeEl = child(el, "time");
            if (timeEl && (isFirstPart || !measureInfo.time)) {
              const time = readTime(timeEl);
              if (time) measureInfo.time = time;
            }
            const st = childNumber(el, "staves");
            if (st && st > part.staves) part.staves = st;
            for (const clefEl of elements(el, "clef")) {
              const staff = Number(clefEl.getAttribute("number") ?? 1);
              const clef = readClef(clefEl);
              if (!clef) continue;
              if (mIndex === 0 && cmp(cursor, ZERO) === 0 && !part.clefs[staff - 1]) part.clefs[staff - 1] = clef;
              else pm.clefChanges!.push({ staff, offset: cursor, clef });
            }
            break;
          }
          case "backup": {
            cursor = sub(cursor, toWhole(childNumber(el, "duration") ?? 0));
            if (lt(cursor, ZERO)) cursor = ZERO;
            break;
          }
          case "forward": {
            cursor = add(cursor, toWhole(childNumber(el, "duration") ?? 0));
            break;
          }
          case "note": {
            const staff = childNumber(el, "staff") ?? 1;
            if (staff > part.staves) part.staves = staff;
            const voiceNumber = Number.parseInt(childText(el, "voice") ?? "1", 10) || 1;
            const isChord = !!child(el, "chord");
            const graceEl = child(el, "grace");
            const restEl = child(el, "rest");
            const pitchEl = child(el, "pitch");
            const divs = childNumber(el, "duration") ?? 0;
            const actual = toWhole(divs);

            const tieTypes = new Set(elements(el, "tie").map((t) => t.getAttribute("type")));
            const notations = elements(el, "notations");
            for (const n of notations) for (const t of elements(n, "tied")) tieTypes.add(t.getAttribute("type"));
            const { articulations, slurs } = readNotations(notations);

            const invisible = el.getAttribute("print-object") === "no";
            if (isChord) {
              // Chord tones share the previous note's time; they never move the cursor.
              if (lastNote && pitchEl && !invisible) {
                const note = this.makeNote(pitchEl, noteInterval, tieTypes);
                lastNote.event.notes.push(note);
                lastNote.event.notes.sort((a, b) => midiNumber(a.pitch) - midiNumber(b.pitch));
                mergeMarks(lastNote.event, articulations, slurs);
              } else if (child(el, "unpitched")) {
                this.warn("Percussion (unpitched) notes are not supported and were replaced by rests.");
              }
              break;
            }

            const duration = this.readDuration(el, graceEl ? undefined : actual, measureInfo.number);
            const id = newId("e");
            let event: MusicEvent;
            if (pitchEl && !child(el, "cue") && !invisible) {
              const noteEvent: NoteEvent = { kind: "note", id, duration, notes: [this.makeNote(pitchEl, noteInterval, tieTypes)] };
              if (graceEl) noteEvent.grace = graceEl.getAttribute("slash") === "yes" ? { slash: true } : {};
              if (articulations.length) noteEvent.articulations = articulations;
              if (slurs.length) noteEvent.slurs = slurs;
              event = noteEvent;
              lastNote = { event: noteEvent, staff };
              const pos = readImagePosition(el);
              if (pos) this.imagePositions[id] = pos;
            } else {
              if (child(el, "unpitched")) this.warn("Percussion (unpitched) notes are not supported and were replaced by rests.");
              if (child(el, "cue")) this.warn("Cue notes were replaced by rests.");
              if (graceEl) break; // a pitchless grace note carries nothing
              event = { kind: "rest", id, duration };
              const barLength = this.timeAt(mIndex);
              if (
                restEl?.getAttribute("measure") === "yes" ||
                (event.duration.type === "whole" && !event.duration.tuplet && barLength && cmp(actual, barLength) === 0)
              ) {
                event.measureRest = true;
                event.duration = { type: "whole", dots: 0 };
              }
              if (invisible) event.hidden = true;
              lastNote = undefined;
            }

            const existing = builds.get(`${staff}/${voiceNumber}`);
            const onset = this.options.sequentialVoices && existing ? existing.end : cursor;
            const build = voiceAt(staff, voiceNumber, onset);
            build.voice.events.push(event);
            if (!graceEl) {
              const value = event.kind === "rest" && event.measureRest ? actual : durationValue(event.duration);
              build.end = add(build.end, value);
              cursor = add(cursor, actual);
            }
            break;
          }
          case "direction": {
            this.readDirection(el, cursor, toWhole, pm, measureInfo, isFirstPart);
            break;
          }
          case "barline": {
            readBarline(el, measureInfo);
            break;
          }
          case "sound": {
            const tempo = Number(el.getAttribute("tempo"));
            if (tempo > 0 && !measureInfo.tempo) measureInfo.tempo = { bpm: Math.round(tempo), beatUnit: "quarter" };
            break;
          }
          case "print":
            if (isFirstPart && (el.getAttribute("new-system") === "yes" || el.getAttribute("new-page") === "yes")) {
              this.systemStarts.add(mIndex);
            }
            break;
          case "harmony":
            this.warn("Chord symbols are not supported yet and were skipped.");
            break;
          case "figured-bass":
            this.warn("Figured bass is not supported and was skipped.");
            break;
          default:
            break;
        }
      }

      // Measure rests in files written for a different bar length keep the time of the bar.
      pm.voices = [...builds.values()]
        .map((b) => b.voice)
        .filter((v) => v.events.some((e) => !(e.kind === "rest" && e.hidden)))
        .sort((a, b) => a.staff - b.staff || a.voice - b.voice);
      if (pm.clefChanges!.length === 0) delete pm.clefChanges;
      if (pm.directions!.length === 0) delete pm.directions;
      part.measures.push(pm);
    });

    // Default clefs for staves that never got one.
    for (let s = 0; s < part.staves; s++) {
      part.clefs[s] ??= instrument.clefs[s] ?? (s === 0 ? { sign: "G", line: 2 } : { sign: "F", line: 4 });
    }
    // Every staff needs a voice in every bar.
    for (const pm of part.measures) ensureStaffVoices(pm, part.staves);
    return part;
  }

  private makeNote(pitchEl: Element, interval: Interval, tieTypes: Set<string | null>): Note {
    const written = {
      step: (childText(pitchEl, "step") ?? "C").toUpperCase() as Step,
      alter: Math.round(childNumber(pitchEl, "alter") ?? 0),
      octave: childNumber(pitchEl, "octave") ?? 4,
    };
    const note: Note = { id: newId("n"), pitch: isUnison(interval) ? written : transposePitch(written, interval) };
    if (tieTypes.has("start") || tieTypes.has("stop")) {
      note.tie = {};
      if (tieTypes.has("start")) note.tie.start = true;
      if (tieTypes.has("stop")) note.tie.stop = true;
    }
    return note;
  }

  private readDuration(el: Element, actual: Fraction | undefined, measureNumber: string): Duration {
    const typeText = childText(el, "type");
    const type = normalizeType(typeText);
    const dots = elements(el, "dot").length;
    const tm = child(el, "time-modification");
    const actualNotes = childNumber(tm, "actual-notes");
    const normalNotes = childNumber(tm, "normal-notes");
    const tuplet = actualNotes && normalNotes && actualNotes !== normalNotes ? { actual: actualNotes, normal: normalNotes } : undefined;

    if (type) {
      const duration: Duration = { type, dots, ...(tuplet ? { tuplet } : {}) };
      if (!actual || cmp(actual, ZERO) === 0) return duration;
      const nominal = durationValue(duration);
      if (cmp(nominal, actual) === 0) return duration;
      // Rounded durations (tuplets in files whose divisions can't express them): trust the type.
      if (Math.abs(toNumber(actual) / toNumber(nominal) - 1) < 0.03) return duration;
      const plain = durationFromValue(actual);
      if (plain) return plain;
      this.warn(`Bar ${measureNumber} contains notes whose length doesn't match their printed type; the length was kept.`);
      // Keep the printed type and express the real length as a tuplet ratio.
      const base = durationValue({ type, dots });
      const ratio = div(actual, base);
      return { type, dots, tuplet: { actual: ratio.d, normal: ratio.n } };
    }
    if (actual && cmp(actual, ZERO) > 0) return exactDuration(actual);
    return { type: "quarter", dots: 0 };
  }

  private readDirection(
    el: Element,
    cursor: Fraction,
    toWhole: (divs: number) => Fraction,
    pm: PartMeasure,
    info: MeasureInfo,
    isFirstPart: boolean,
  ) {
    const staff = childNumber(el, "staff") ?? 1;
    const offsetDivs = childNumber(el, "offset") ?? 0;
    let offset = add(cursor, toWhole(offsetDivs));
    if (lt(offset, ZERO)) offset = ZERO;
    const placementAttr = el.getAttribute("placement");
    const placement = placementAttr === "above" || placementAttr === "below" ? placementAttr : undefined;
    let tempo: Tempo | undefined;
    const words: string[] = [];

    for (const dt of elements(el, "direction-type")) {
      for (const item of elements(dt)) {
        switch (item.nodeName) {
          case "dynamics":
            for (const d of elements(item)) {
              const name = d.nodeName as Dynamic;
              if ((DYNAMICS as readonly string[]).includes(name)) {
                pm.directions!.push({ id: newId("d"), kind: "dynamic", staff, offset, value: name });
              } else if (d.nodeName === "other-dynamics" && d.textContent?.trim()) {
                words.push(d.textContent.trim());
              }
            }
            break;
          case "words": {
            const text = item.textContent?.trim();
            if (text) words.push(text);
            break;
          }
          case "wedge": {
            const type = item.getAttribute("type");
            if (type === "crescendo" || type === "diminuendo" || type === "stop") {
              pm.directions!.push({ id: newId("d"), kind: "wedge", staff, offset, type });
            }
            break;
          }
          case "metronome": {
            const unit = normalizeType(childText(item, "beat-unit"));
            const perMinute = Number(/[\d.]+/.exec(childText(item, "per-minute") ?? "")?.[0]);
            if (unit && perMinute > 0) {
              tempo = { bpm: Math.round(perMinute), beatUnit: unit };
              const dots = elements(item, "beat-unit-dot").length;
              if (dots) tempo.beatUnitDots = dots;
            }
            break;
          }
          case "rehearsal": {
            const text = item.textContent?.trim();
            if (text && (isFirstPart || !info.rehearsal)) info.rehearsal = text;
            break;
          }
          case "segno":
            words.push("Segno");
            break;
          case "coda":
            words.push("Coda");
            break;
          default:
            break;
        }
      }
    }
    const sound = child(el, "sound");
    const soundTempo = Number(sound?.getAttribute("tempo"));
    if (!tempo && soundTempo > 0) tempo = { bpm: Math.round(soundTempo), beatUnit: "quarter" };

    if (tempo) {
      if (words.length) tempo.text = words.join(" ");
      if (!info.tempo) info.tempo = tempo;
    } else {
      for (const text of words) {
        const direction: Direction = { id: newId("d"), kind: "words", staff, offset, text };
        if (placement) direction.placement = placement;
        pm.directions!.push(direction);
      }
    }
  }
}

/**
 * Mark intentionally short bars as implicit so they aren't reported as incomplete: a short first bar
 * (pickup), and, in scores with several parts, bars that all parts agree are short next to a repeat
 * or double barline (a bar split around a repeat).
 */
function markShortMeasures(score: Score) {
  const lengths = measureLengths(score);
  score.measures.forEach((info, m) => {
    if (info.implicit) return;
    if (m > 0) {
      const prev = score.measures[m - 1];
      const nearBreak =
        info.repeatStart || info.repeatEnd || info.ending || (info.barline && info.barline !== "regular") ||
        prev?.repeatEnd || (prev?.barline && prev.barline !== "regular");
      if (score.parts.length < 2 || !nearBreak) return;
    }
    let common: Fraction | undefined;
    for (const part of score.parts) {
      const pm = part.measures[m];
      if (!pm || pm.voices.length === 0) return;
      let longest = ZERO;
      for (const v of pm.voices) {
        const len = voiceLength(v, lengths[m]!);
        if (cmp(len, longest) > 0) longest = len;
      }
      if (cmp(longest, ZERO) === 0 || cmp(longest, lengths[m]!) >= 0) return;
      if (common && cmp(common, longest) !== 0) return;
      common = longest;
    }
    if (common) info.implicit = true;
  });
}

const SNAP = frac(1, 256);

function nearlyEqual(a: Fraction, b: Fraction): boolean {
  const d = sub(a, b);
  return cmp(d.n < 0 ? frac(-d.n, d.d) : d, SNAP) <= 0;
}

function readTranspose(el: Element): Interval {
  const diatonic = childNumber(el, "diatonic") ?? 0;
  const chromatic = childNumber(el, "chromatic") ?? 0;
  const octave = childNumber(el, "octave-change") ?? 0;
  return { diatonic: diatonic + 7 * octave, chromatic: chromatic + 12 * octave };
}

function readTime(el: Element) {
  const symbol = el.getAttribute("symbol");
  const beatsList = elements(el, "beats").map((b) => b.textContent?.trim() ?? "");
  const typeList = elements(el, "beat-type").map((b) => Number(b.textContent?.trim()));
  if (beatsList.length === 0 || typeList.length === 0) return undefined;
  // Composite signatures ("3+2", or several beats/beat-type pairs) are summed.
  let total = ZERO;
  beatsList.forEach((beats, i) => {
    const type = typeList[i] ?? typeList[0]!;
    const count = beats.split("+").reduce((s, x) => s + (Number(x) || 0), 0);
    total = add(total, frac(count, type));
  });
  const beatType = Math.max(...typeList);
  const beats = (total.n * beatType) / total.d;
  if (!Number.isInteger(beats) || beats <= 0) return undefined;
  const time: { beats: number; beatType: number; symbol?: "common" | "cut" } = { beats, beatType };
  if (symbol === "common" || symbol === "cut") time.symbol = symbol;
  return time;
}

function readClef(el: Element): Clef | undefined {
  const sign = childText(el, "sign");
  if (sign === "G" || sign === "F" || sign === "C") {
    const line = childNumber(el, "line") ?? (sign === "G" ? 2 : sign === "F" ? 4 : 3);
    const clef: Clef = { sign, line };
    const octave = childNumber(el, "clef-octave-change");
    if (octave) clef.octaveChange = octave;
    return clef;
  }
  if (sign === "percussion") return { sign: "percussion", line: 3 };
  return undefined;
}

function readNotations(notations: Element[]): { articulations: Articulation[]; slurs: SlurMark[] } {
  const articulations: Articulation[] = [];
  const slurs: SlurMark[] = [];
  for (const n of notations) {
    for (const item of elements(n)) {
      switch (item.nodeName) {
        case "slur": {
          const type = item.getAttribute("type");
          if (type === "start" || type === "stop") {
            const number = Number(item.getAttribute("number") ?? 1);
            slurs.push(number === 1 ? { type } : { type, number });
          }
          break;
        }
        case "articulations":
          for (const a of elements(item)) for (const mapped of ARTICULATION_MAP[a.nodeName] ?? []) articulations.push(mapped);
          break;
        case "ornaments":
          for (const o of elements(item)) {
            const mapped = ORNAMENT_MAP[o.nodeName];
            if (mapped) articulations.push(mapped);
          }
          break;
        case "fermata":
          articulations.push("fermata");
          break;
        default:
          break;
      }
    }
  }
  return { articulations: [...new Set(articulations)], slurs };
}

function mergeMarks(event: NoteEvent, articulations: Articulation[], slurs: SlurMark[]) {
  if (articulations.length) event.articulations = [...new Set([...(event.articulations ?? []), ...articulations])];
  if (slurs.length) event.slurs = [...(event.slurs ?? []), ...slurs];
}

function readBarline(el: Element, info: MeasureInfo) {
  const location = el.getAttribute("location") ?? "right";
  const style = childText(el, "bar-style");
  const repeat = child(el, "repeat");
  const ending = child(el, "ending");
  if (location === "right" && style && BAR_STYLES[style] && style !== "regular") info.barline = BAR_STYLES[style];
  if (repeat?.getAttribute("direction") === "forward") info.repeatStart = true;
  if (repeat?.getAttribute("direction") === "backward") {
    const times = Number(repeat.getAttribute("times"));
    info.repeatEnd = times > 0 ? { times } : {};
  }
  if (ending) {
    const type = ending.getAttribute("type");
    const number = ending.getAttribute("number") ?? ending.textContent?.trim() ?? "1";
    info.ending ??= { number, start: false, stop: false };
    if (type === "start") info.ending.start = true;
    if (type === "stop") info.ending.stop = true;
    if (type === "discontinue") {
      info.ending.stop = true;
      info.ending.open = true;
    }
  }
}

function readImagePosition(noteEl: Element): { x: number; y: number } | undefined {
  for (const comment of childComments(noteEl)) {
    const match = /imgpos:\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)/.exec(comment);
    if (match) return { x: Number(match[1]), y: Number(match[2]) };
  }
  return undefined;
}

function normalizeType(text: string | undefined): NoteType | undefined {
  if (!text) return undefined;
  if (text === "long" || text === "maxima") return "breve";
  if (text === "256th" || text === "512th" || text === "1024th") return "128th";
  return (NOTE_TYPES as readonly string[]).includes(text) ? (text as NoteType) : undefined;
}

function emptyMeasureFor(staves: number): PartMeasure {
  const pm: PartMeasure = { voices: [] };
  ensureStaffVoices(pm, staves);
  return pm;
}

function ensureStaffVoices(pm: PartMeasure, staves: number) {
  for (let staff = 1; staff <= staves; staff++) {
    if (!pm.voices.some((v) => v.staff === staff)) {
      pm.voices.push({
        staff,
        voice: 1,
        events: [{ kind: "rest", id: newId("e"), duration: { type: "whole", dots: 0 }, measureRest: true }],
      });
    }
  }
  pm.voices.sort((a, b) => a.staff - b.staff || a.voice - b.voice);
}
