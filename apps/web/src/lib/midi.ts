/**
 * MIDI keyboards (Web MIDI: Chrome, Edge and Firefox on computers and Android; not Safari). Keys
 * pressed together, within a few hundredths of a second, arrive as one chord.
 */
import { create } from "zustand";

/** A key pressed (velocity > 0) or released, from a MIDI message; null for anything else. */
export function parseMidi(data: ArrayLike<number>): { on: boolean; note: number; velocity: number } | null {
  const status = (data[0] ?? 0) & 0xf0;
  const note = data[1] ?? 0;
  const velocity = data[2] ?? 0;
  if (status === 0x90 && velocity > 0) return { on: true, note, velocity };
  if (status === 0x80 || status === 0x90) return { on: false, note, velocity: 0 };
  return null;
}

/** How long after the first key the others still count as the same chord (seconds). */
export const CHORD_WINDOW = 0.04;

/** Gathers the keys of a chord: the first key starts it, keys within the window join it. */
export class ChordGatherer {
  private keys: number[] = [];
  private loudest = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly onChord: (notes: number[], velocity: number) => void) {}

  press(note: number, velocity: number) {
    this.keys.push(note);
    this.loudest = Math.max(this.loudest, velocity);
    this.timer ??= setTimeout(() => {
      const keys = this.keys;
      const velocity = this.loudest;
      this.keys = [];
      this.loudest = 0;
      this.timer = null;
      this.onChord(keys, velocity);
    }, CHORD_WINDOW * 1000);
  }

  dispose() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.keys = [];
  }
}

export type MidiStatus = "off" | "connecting" | "on" | "denied";
type ChordListener = (notes: number[], velocity: number) => void;

const ENABLED_KEY = "musicraft.midi";
const listeners = new Set<ChordListener>();
let access: MIDIAccess | null = null;
let gatherer: ChordGatherer | null = null;

/** Whether this browser can use MIDI keyboards at all. */
export const midiSupported = () => typeof navigator !== "undefined" && "requestMIDIAccess" in navigator;

function remember(on: boolean) {
  try {
    localStorage.setItem(ENABLED_KEY, on ? "on" : "off");
  } catch {
    // Not remembered in this browser.
  }
}

/** Whether the user connected a keyboard last time (to connect again when a score opens). */
export function midiWanted(): boolean {
  try {
    return localStorage.getItem(ENABLED_KEY) === "on";
  } catch {
    return false;
  }
}

/** Hear about chords played (while a keyboard is connected). Returns the function that stops it. */
export function onMidiChord(listener: ChordListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function listen(midi: MIDIAccess) {
  gatherer ??= new ChordGatherer((notes, velocity) => listeners.forEach((l) => l(notes, velocity)));
  const attach = () => {
    const names: string[] = [];
    midi.inputs.forEach((input) => {
      input.onmidimessage = (event) => {
        const key = event.data ? parseMidi(event.data) : null;
        if (key?.on) gatherer?.press(key.note, key.velocity);
      };
      if (input.state !== "disconnected") names.push(input.name || "MIDI keyboard");
    });
    useMidi.setState({ devices: names });
  };
  attach();
  // Keyboards plugged in (or out) later.
  midi.onstatechange = attach;
}

export const useMidi = create<{
  status: MidiStatus;
  devices: string[];
  connect: () => Promise<void>;
  disconnect: () => void;
}>((set) => ({
  status: "off",
  devices: [],
  async connect() {
    if (!midiSupported()) return;
    set({ status: "connecting" });
    try {
      access = await navigator.requestMIDIAccess({ sysex: false });
      listen(access);
      set({ status: "on" });
      remember(true);
    } catch {
      set({ status: "denied", devices: [] });
      remember(false);
    }
  },
  disconnect() {
    if (access) {
      access.inputs.forEach((input) => (input.onmidimessage = null));
      access.onstatechange = null;
    }
    access = null;
    gatherer?.dispose();
    gatherer = null;
    set({ status: "off", devices: [] });
    remember(false);
  },
}));
