import type { Clef } from "./model";
import { parseInterval, parsePitch, UNISON, type Interval, type Pitch } from "./pitch";

export type InstrumentFamily = "brass" | "woodwind" | "strings" | "keyboard" | "voice" | "other";

export interface InstrumentDef {
  id: string;
  name: string;
  abbreviation: string;
  family: InstrumentFamily;
  /** Interval from written to sounding pitch: a Bb trumpet's written C sounds Bb, so -M2. */
  transposition: Interval;
  staves: number;
  /** Default clef per staff. */
  clefs: Clef[];
  /** Full range, written pitch. */
  range: { low: Pitch; high: Pitch };
  /** Range an average amateur plays comfortably, written pitch. */
  comfortable: { low: Pitch; high: Pitch };
  /** General MIDI program, 0-based. */
  midiProgram: number;
  /** MusicXML instrument-sound id. */
  sound?: string;
  /** Lower-case names used to recognise the instrument from part names. */
  keywords: string[];
  /** Instruments sharing a group differ only in pitch (trumpet in Bb/C/D/Eb); used when matching names. */
  group?: string;
}

const GROUPS: Record<string, string> = {
  "trumpet-bb": "trumpet",
  "trumpet-c": "trumpet",
  "trumpet-d": "trumpet",
  "trumpet-eb": "trumpet",
  "clarinet-bb": "clarinet",
  "clarinet-a": "clarinet",
  "clarinet-eb": "clarinet",
  euphonium: "euphonium",
  "euphonium-tc": "euphonium",
};

const G: Clef = { sign: "G", line: 2 };
const F: Clef = { sign: "F", line: 4 };
const ALTO: Clef = { sign: "C", line: 3 };
const G8VB: Clef = { sign: "G", line: 2, octaveChange: -1 };

function def(
  id: string,
  name: string,
  abbreviation: string,
  family: InstrumentFamily,
  transposition: string,
  clefs: Clef[],
  range: [string, string],
  comfortable: [string, string],
  midiProgram: number,
  keywords: string[],
  sound?: string,
): InstrumentDef {
  const group = GROUPS[id];
  return {
    id,
    name,
    abbreviation,
    family,
    transposition: transposition === "P1" ? UNISON : parseInterval(transposition),
    staves: clefs.length,
    clefs,
    range: { low: parsePitch(range[0]), high: parsePitch(range[1]) },
    comfortable: { low: parsePitch(comfortable[0]), high: parsePitch(comfortable[1]) },
    midiProgram,
    keywords,
    sound,
    ...(group ? { group } : {}),
  };
}

export const INSTRUMENTS: readonly InstrumentDef[] = [
  // Brass
  def("trumpet-bb", "Trumpet in Bb", "Tpt.", "brass", "-M2", [G], ["F#3", "D6"], ["A3", "G5"], 56,
    ["trumpet in bb", "bb trumpet", "b flat trumpet", "trumpet", "tpt", "trp", "tromba"], "brass.trumpet.bflat"),
  def("trumpet-c", "Trumpet in C", "Tpt.", "brass", "P1", [G], ["F#3", "D6"], ["A3", "G5"], 56,
    ["trumpet in c", "c trumpet"], "brass.trumpet.c"),
  def("trumpet-d", "Trumpet in D", "Tpt.", "brass", "M2", [G], ["F#3", "C6"], ["A3", "F5"], 56,
    ["trumpet in d", "d trumpet"]),
  def("trumpet-eb", "Trumpet in Eb", "Tpt.", "brass", "m3", [G], ["F#3", "C6"], ["A3", "F5"], 56,
    ["trumpet in eb", "eb trumpet"]),
  def("piccolo-trumpet-bb", "Piccolo Trumpet in Bb", "Picc. Tpt.", "brass", "m7", [G], ["F#3", "G5"], ["C4", "E5"], 56,
    ["piccolo trumpet"]),
  def("cornet-bb", "Cornet in Bb", "Cnt.", "brass", "-M2", [G], ["F#3", "D6"], ["A3", "G5"], 56,
    ["cornet in bb", "bb cornet", "cornet", "cnt"], "brass.cornet"),
  def("soprano-cornet-eb", "Soprano Cornet in Eb", "Sop. Cnt.", "brass", "m3", [G], ["F#3", "C6"], ["A3", "F5"], 56,
    ["soprano cornet", "eb cornet"]),
  def("flugelhorn", "Flugelhorn in Bb", "Flhn.", "brass", "-M2", [G], ["E3", "C6"], ["A3", "F5"], 56,
    ["flugelhorn", "flugel", "flghn", "flhn"], "brass.flugelhorn"),
  def("tenor-horn-eb", "Tenor Horn in Eb", "T. Hn.", "brass", "-M6", [G], ["F#3", "C6"], ["G3", "F5"], 60,
    ["tenor horn", "alto horn", "eb horn"]),
  def("horn-f", "Horn in F", "Hn.", "brass", "-P5", [G], ["F#2", "C6"], ["G3", "G5"], 60,
    ["horn in f", "french horn", "f horn", "horn", "hn", "cor", "corno"], "brass.french-horn"),
  def("trombone", "Trombone", "Tbn.", "brass", "P1", [F], ["E2", "F5"], ["A2", "F4"], 57,
    ["trombone", "tenor trombone", "tbn", "trb", "posaune"], "brass.trombone"),
  def("bass-trombone", "Bass Trombone", "B. Tbn.", "brass", "P1", [F], ["Bb1", "Bb4"], ["C2", "C4"], 57,
    ["bass trombone", "b tbn", "bass tbn"], "brass.trombone.bass"),
  def("baritone-tc", "Baritone in Bb (treble clef)", "Bar.", "brass", "-M9", [G], ["F#3", "C6"], ["G3", "G5"], 58,
    ["baritone horn", "baritone in bb", "baritone tc", "baritone"]),
  def("euphonium", "Euphonium", "Euph.", "brass", "P1", [F], ["Bb1", "Bb4"], ["F2", "F4"], 58,
    ["euphonium", "euph", "euphonium bc"], "brass.euphonium"),
  def("euphonium-tc", "Euphonium in Bb (treble clef)", "Euph.", "brass", "-M9", [G], ["C3", "C6"], ["G3", "G5"], 58,
    ["euphonium tc", "euphonium in bb", "euphonium treble"]),
  def("tuba", "Tuba", "Tba.", "brass", "P1", [F], ["D1", "F4"], ["G1", "C4"], 58,
    ["tuba", "bass tuba", "bb tuba", "c tuba", "tba", "sousaphone"], "brass.tuba"),
  def("bass-eb-tc", "Eb Bass (treble clef)", "Eb Bass", "brass", "-M13", [G], ["F#3", "C6"], ["G3", "E5"], 58,
    ["eb bass", "eb tuba"]),
  def("bass-bb-tc", "Bb Bass (treble clef)", "Bb Bass", "brass", "-M16", [G], ["F#3", "C6"], ["G3", "E5"], 58,
    ["bb bass", "bbb bass"]),

  // Woodwinds
  def("piccolo", "Piccolo", "Picc.", "woodwind", "P8", [G], ["D4", "C7"], ["D4", "A6"], 72,
    ["piccolo", "picc", "ottavino"], "wind.flutes.flute.piccolo"),
  def("flute", "Flute", "Fl.", "woodwind", "P1", [G], ["C4", "C7"], ["D4", "A6"], 73,
    ["flute", "fl", "flauto", "flote"], "wind.flutes.flute"),
  def("oboe", "Oboe", "Ob.", "woodwind", "P1", [G], ["Bb3", "A6"], ["C4", "E6"], 68,
    ["oboe", "ob", "hautbois"], "wind.reed.oboe"),
  def("english-horn", "English Horn", "E. Hn.", "woodwind", "-P5", [G], ["B3", "G6"], ["C4", "C6"], 69,
    ["english horn", "cor anglais", "eng hn"], "wind.reed.english-horn"),
  def("clarinet-bb", "Clarinet in Bb", "Cl.", "woodwind", "-M2", [G], ["E3", "C7"], ["G3", "C6"], 71,
    ["clarinet in bb", "bb clarinet", "b flat clarinet", "clarinet", "cl", "clar", "klarinette"],
    "wind.reed.clarinet.bflat"),
  def("clarinet-a", "Clarinet in A", "Cl.", "woodwind", "-m3", [G], ["E3", "C7"], ["G3", "C6"], 71,
    ["clarinet in a", "a clarinet"], "wind.reed.clarinet.a"),
  def("clarinet-eb", "Clarinet in Eb", "E♭ Cl.", "woodwind", "m3", [G], ["E3", "G6"], ["G3", "C6"], 71,
    ["clarinet in eb", "eb clarinet", "e flat clarinet"], "wind.reed.clarinet.eflat"),
  def("bass-clarinet", "Bass Clarinet in Bb", "B. Cl.", "woodwind", "-M9", [G], ["Eb3", "G6"], ["E3", "C6"], 71,
    ["bass clarinet", "b cl"], "wind.reed.clarinet.bass"),
  def("bassoon", "Bassoon", "Bsn.", "woodwind", "P1", [F], ["Bb1", "Eb5"], ["D2", "G4"], 70,
    ["bassoon", "bsn", "fagott", "fagotto"], "wind.reed.bassoon"),
  def("soprano-sax", "Soprano Saxophone", "S. Sax.", "woodwind", "-M2", [G], ["Bb3", "F#6"], ["C4", "C6"], 64,
    ["soprano saxophone", "soprano sax"], "wind.reed.saxophone.soprano"),
  def("alto-sax", "Alto Saxophone", "A. Sax.", "woodwind", "-M6", [G], ["Bb3", "F#6"], ["C4", "C6"], 65,
    ["alto saxophone", "alto sax", "a sax", "eb alto"], "wind.reed.saxophone.alto"),
  def("tenor-sax", "Tenor Saxophone", "T. Sax.", "woodwind", "-M9", [G], ["Bb3", "F#6"], ["C4", "C6"], 66,
    ["tenor saxophone", "tenor sax", "t sax"], "wind.reed.saxophone.tenor"),
  def("baritone-sax", "Baritone Saxophone", "B. Sax.", "woodwind", "-M13", [G], ["Bb3", "F#6"], ["C4", "C6"], 67,
    ["baritone saxophone", "baritone sax", "bari sax", "b sax"], "wind.reed.saxophone.baritone"),

  // Strings
  def("violin", "Violin", "Vln.", "strings", "P1", [G], ["G3", "A7"], ["G3", "E6"], 40,
    ["violin", "vln", "violino", "violine", "fiddle"], "strings.violin"),
  def("viola", "Viola", "Vla.", "strings", "P1", [ALTO], ["C3", "E6"], ["C3", "A5"], 41,
    ["viola", "vla", "bratsche"], "strings.viola"),
  def("cello", "Violoncello", "Vc.", "strings", "P1", [F], ["C2", "C6"], ["C2", "A4"], 42,
    ["violoncello", "cello", "vc", "vlc"], "strings.cello"),
  def("double-bass", "Double Bass", "Cb.", "strings", "-P8", [F], ["E2", "G5"], ["E2", "D4"], 43,
    ["double bass", "contrabass", "string bass", "kontrabass", "cb"], "strings.contrabass"),
  // The octave treble clef shows the guitar an octave above sounding pitch; no transposition needed.
  def("guitar", "Guitar", "Gtr.", "strings", "P1", [G8VB], ["E2", "B5"], ["E2", "A5"], 24,
    ["guitar", "gtr", "acoustic guitar", "classical guitar"], "pluck.guitar"),

  // Keyboards
  def("piano", "Piano", "Pno.", "keyboard", "P1", [G, F], ["A0", "C8"], ["A0", "C8"], 0,
    ["piano", "pno", "pianoforte", "klavier", "keyboard", "pf"], "keyboard.piano"),
  def("organ", "Organ", "Org.", "keyboard", "P1", [G, F], ["C2", "C7"], ["C2", "C7"], 19,
    ["organ", "org", "orgel"], "keyboard.organ"),

  // Voices
  def("soprano", "Soprano", "S.", "voice", "P1", [G], ["Bb3", "C6"], ["D4", "G5"], 52, ["soprano", "sop"], "voice.soprano"),
  def("alto", "Alto", "A.", "voice", "P1", [G], ["D3", "G5"], ["G3", "C5"], 52, ["alto voice", "alto", "contralto"],
    "voice.alto"),
  def("tenor", "Tenor", "T.", "voice", "P1", [G8VB], ["A2", "C5"], ["C3", "G4"], 52, ["tenor voice", "tenor"],
    "voice.tenor"),
  def("bass-voice", "Bass", "B.", "voice", "P1", [F], ["D2", "F4"], ["G2", "C4"], 52, ["bass voice", "basso"],
    "voice.bass"),
  def("voice", "Voice", "V.", "voice", "P1", [G], ["E2", "C6"], ["A2", "G5"], 52, ["voice", "vocals", "vox", "singer"],
    "voice.vocals"),

  // Fallbacks
  def("generic-treble", "Instrument in C (treble clef)", "Inst.", "other", "P1", [G], ["C2", "C8"], ["C2", "C8"], 0, []),
  def("generic-bass", "Instrument in C (bass clef)", "Inst.", "other", "P1", [F], ["C1", "C7"], ["C1", "C7"], 0, []),
];

const BY_ID = new Map(INSTRUMENTS.map((i) => [i.id, i]));

export const DEFAULT_INSTRUMENT_ID = "generic-treble";

export function getInstrument(id: string): InstrumentDef {
  return BY_ID.get(id) ?? BY_ID.get(DEFAULT_INSTRUMENT_ID)!;
}

export function hasInstrument(id: string): boolean {
  return BY_ID.has(id);
}

/** "Trumpet in Bb" → "Trumpet in B♭" for display. */
export function prettyName(name: string): string {
  return name.replace(/\b([A-G])b\b/g, "$1♭").replace(/\b([A-G])#/g, "$1♯");
}

function normalizeName(text: string): string {
  return (
    " " +
    text
      .toLowerCase()
      .replace(/♭/g, "b")
      .replace(/♯/g, "#")
      .replace(/\b([a-g])[- ]flat\b/g, "$1b")
      .replace(/\b([a-g])[- ]sharp\b/g, "$1#")
      .replace(/[.,:;()[\]{}/\\_-]+/g, " ")
      .replace(/\b(1st|2nd|3rd|4th|[1-4]|i{1,3}|iv|solo|div|tutti)\b/g, " ")
      .replace(/\s+/g, " ")
      .trim() +
    " "
  );
}

function sameInterval(a: Interval, b: Interval) {
  return a.diatonic === b.diatonic && a.chromatic === b.chromatic;
}

/**
 * Recognise an instrument from a part name such as "1st Bb TRUMPET" or "Pno.". When the
 * written→sounding transposition is known (MusicXML <transpose>), it breaks ties.
 */
export function matchInstrument(name: string, transposition?: Interval): InstrumentDef | undefined {
  const text = normalizeName(name);
  let best: InstrumentDef | undefined;
  let bestScore = 0;
  for (const instrument of INSTRUMENTS) {
    for (const keyword of instrument.keywords) {
      if (!text.includes(` ${keyword} `)) continue;
      let score = keyword.length * 10;
      if (transposition && sameInterval(transposition, instrument.transposition)) score += 1000;
      if (score > bestScore) {
        best = instrument;
        bestScore = score;
      }
    }
  }
  // "Trumpet" without a key: pick the member of the family with the known transposition.
  if (best && transposition && !sameInterval(best.transposition, transposition) && best.group) {
    const sibling = INSTRUMENTS.find((i) => i.group === best!.group && sameInterval(i.transposition, transposition));
    if (sibling) return sibling;
  }
  return best;
}

export function instrumentForSound(sound: string): InstrumentDef | undefined {
  return INSTRUMENTS.find((i) => i.sound === sound);
}

// ---------------------------------------------------------------------------
// Ensembles
// ---------------------------------------------------------------------------

export interface EnsembleTemplate {
  id: string;
  name: string;
  description: string;
  parts: { instrument: string; name: string }[];
}

export const ENSEMBLES: readonly EnsembleTemplate[] = [
  {
    id: "brass-quintet",
    name: "Brass quintet (Bb trumpets)",
    description: "2 trumpets in Bb, horn in F, trombone, tuba",
    parts: [
      { instrument: "trumpet-bb", name: "Trumpet 1 in Bb" },
      { instrument: "trumpet-bb", name: "Trumpet 2 in Bb" },
      { instrument: "horn-f", name: "Horn in F" },
      { instrument: "trombone", name: "Trombone" },
      { instrument: "tuba", name: "Tuba" },
    ],
  },
  {
    id: "brass-quintet-c",
    name: "Brass quintet (C trumpets)",
    description: "2 trumpets in C, horn in F, trombone, tuba",
    parts: [
      { instrument: "trumpet-c", name: "Trumpet 1 in C" },
      { instrument: "trumpet-c", name: "Trumpet 2 in C" },
      { instrument: "horn-f", name: "Horn in F" },
      { instrument: "trombone", name: "Trombone" },
      { instrument: "tuba", name: "Tuba" },
    ],
  },
  {
    id: "brass-quartet",
    name: "Brass quartet",
    description: "2 trumpets in Bb, horn in F, trombone",
    parts: [
      { instrument: "trumpet-bb", name: "Trumpet 1 in Bb" },
      { instrument: "trumpet-bb", name: "Trumpet 2 in Bb" },
      { instrument: "horn-f", name: "Horn in F" },
      { instrument: "trombone", name: "Trombone" },
    ],
  },
  {
    id: "brass-trio",
    name: "Brass trio",
    description: "Trumpet in Bb, horn in F, trombone",
    parts: [
      { instrument: "trumpet-bb", name: "Trumpet in Bb" },
      { instrument: "horn-f", name: "Horn in F" },
      { instrument: "trombone", name: "Trombone" },
    ],
  },
];

export function getEnsemble(id: string): EnsembleTemplate | undefined {
  return ENSEMBLES.find((e) => e.id === id);
}
