/**
 * Where the players sit on the stage. Coordinates are metres: the conductor stands at the origin
 * facing the players (towards -z); x runs to the right as seen by the conductor and the audience,
 * who sit behind the conductor (+z).
 */
import { getInstrument, midiNumber, transposePitch, type InstrumentDef, type Score } from "@musicraft/score-core";
import type { Vec3 } from "../audio/player";

export type Venue = "hall" | "bandstand";

export const VENUES: { value: Venue; label: string; description: string }[] = [
  { value: "hall", label: "Concert hall", description: "An indoor stage with risers, a wooden shell and the hall's reverberation." },
  { value: "bandstand", label: "Bandstand", description: "An open-air bandstand in a park: a drier sound that carries less." },
];

/** A player's place: on the floor (y is the height of the riser under them), turned to face the conductor. */
export interface Seat {
  partId: string;
  partIndex: number;
  x: number;
  y: number;
  z: number;
  /** Turn around the vertical axis, in degrees (0 = facing the audience). */
  rotation: number;
  /** Arc (row) from the front, 0-based. */
  row: number;
}

/** A place the user dragged a player to. */
export interface SeatOverride {
  x: number;
  z: number;
}

/** Radius of the first arc of chairs around the conductor, and the distance between arcs. */
export const FIRST_ROW = 2.6;
export const ROW_GAP = 1.35;
/** Width taken by one seated player along an arc. */
const SEAT_WIDTH = 1.15;
/** Widest arc, in radians (150°). */
const MAX_SPAN = (150 * Math.PI) / 180;
/** Height of each riser step in the hall. */
export const RISER_STEP = 0.22;
/** The bandstand's floor is raised this much above the grass. */
export const BANDSTAND_HEIGHT = 0.9;

/** Sections are seated from the front: voices, strings and keyboards, then woodwinds, upper brass, lower brass. */
function section(instrument: InstrumentDef): number {
  if (instrument.family === "voice" || instrument.family === "strings" || instrument.family === "keyboard") return 0;
  if (instrument.family === "woodwind") return 1;
  if (instrument.family === "brass") return LOW_BRASS.has(instrument.id) ? 3 : 2;
  return 2;
}

const LOW_BRASS = new Set(["trombone", "bass-trombone", "baritone-tc", "euphonium", "euphonium-tc", "tuba", "bass-eb-tc", "bass-bb-tc"]);

/** The middle of an instrument's comfortable range, as a sounding MIDI number. */
export function register(instrument: InstrumentDef): number {
  const low = midiNumber(transposePitch(instrument.comfortable.low, instrument.transposition));
  const high = midiNumber(transposePitch(instrument.comfortable.high, instrument.transposition));
  return (low + high) / 2;
}

/** How many seat widths a player takes (a grand piano needs room). */
function width(instrument: InstrumentDef): number {
  return instrument.family === "keyboard" ? 2.2 : instrument.id === "double-bass" || instrument.id === "tuba" ? 1.3 : 1;
}

function rowRadius(row: number): number {
  return FIRST_ROW + row * ROW_GAP;
}

/** Seat widths that fit on an arc. */
function capacity(row: number): number {
  return Math.floor((MAX_SPAN * rowRadius(row)) / SEAT_WIDTH) + 1;
}

/** Turn (degrees) that makes a player at (x, z) face the conductor at the origin. */
export function facingConductor(x: number, z: number): number {
  return (Math.atan2(-x, -z) * 180) / Math.PI;
}

/** Height of the floor at a place on the stage. */
export function floorHeight(venue: Venue, x: number, z: number, rows: number): number {
  if (venue === "bandstand") return BANDSTAND_HEIGHT;
  const radius = Math.hypot(x, z);
  const angle = Math.abs(Math.atan2(x, -z));
  // Risers are arcs behind the first row, up to 85° to either side.
  if (z > 0 || angle > (85 * Math.PI) / 180) return 0;
  const step = Math.round((radius - FIRST_ROW) / ROW_GAP);
  return Math.max(0, Math.min(rows - 1, step)) * RISER_STEP;
}

/** Keep a dragged player on the stage. */
export function clampToStage(venue: Venue, x: number, z: number, rows: number): SeatOverride {
  const outer = rowRadius(Math.max(rows, 2)) + 0.6;
  if (venue === "bandstand") {
    const center = bandstandCenter(rows);
    const radius = bandstandRadius(rows) - 0.7;
    const dx = x - center.x;
    const dz = z - center.z;
    const distance = Math.hypot(dx, dz);
    const scale = distance > radius ? radius / distance : 1;
    return { x: center.x + dx * scale, z: center.z + dz * scale };
  }
  // In front of the conductor is the audience.
  const cz = Math.min(z, -1.2);
  const distance = Math.hypot(x, cz);
  const scale = distance > outer ? outer / distance : 1;
  return { x: x * scale, z: cz * scale };
}

/** The bandstand is an octagon around the players, with the conductor at its front edge. */
export function bandstandCenter(rows: number): { x: number; z: number } {
  return { x: 0, z: -(FIRST_ROW + (Math.max(rows, 1) - 1) * ROW_GAP) / 2 - 0.6 };
}

export function bandstandRadius(rows: number): number {
  return rowRadius(Math.max(rows, 1) - 1) + 1.9;
}

/**
 * Seat every part: arcs around the conductor, filled from the front by section (voices, strings
 * and keyboards, woodwinds, upper brass, lower brass), higher instruments to the left as in an
 * orchestra (violins, or trumpets before trombones). Dragged players keep their place.
 */
export function arrangeSeats(score: Score, venue: Venue, overrides: Record<string, SeatOverride> = {}): Seat[] {
  const players = score.parts.map((part, index) => {
    const instrument = getInstrument(part.instrument);
    // A piano goes at the left end of its row, where its lid doesn't hide anyone.
    const edge = instrument.family === "keyboard" ? 0 : 1;
    return { part, index, instrument, section: section(instrument), register: register(instrument), width: width(instrument), edge };
  });
  const ordered = [...players].sort((a, b) => a.section - b.section || b.register - a.register || a.index - b.index);

  // Fill the arcs from the front.
  const rows: (typeof players)[] = [];
  let current: typeof players = [];
  let used = 0;
  for (const player of ordered) {
    if (current.length && used + player.width > capacity(rows.length)) {
      rows.push(current);
      current = [];
      used = 0;
    }
    current.push(player);
    used += player.width;
  }
  if (current.length) rows.push(current);

  const seats: Seat[] = [];
  rows.forEach((row, r) => {
    // Within an arc, higher instruments sit further left (keyboards at the very left).
    row.sort((a, b) => a.edge - b.edge || b.register - a.register || a.index - b.index);
    const radius = rowRadius(r);
    const total = row.reduce((sum, p) => sum + p.width, 0);
    const span = Math.min(MAX_SPAN, ((total - 1) * SEAT_WIDTH) / radius);
    const step = total > 1 ? span / (total - 1) : 0;
    let slot = 0;
    for (const player of row) {
      const centre = slot + (player.width - 1) / 2;
      const angle = -span / 2 + centre * step;
      slot += player.width;
      const x = radius * Math.sin(angle);
      const z = -radius * Math.cos(angle);
      seats.push({ partId: player.part.id, partIndex: player.index, x, z, y: 0, rotation: facingConductor(x, z), row: r });
    }
  });

  const rowCount = Math.max(rows.length, 1);
  for (const seat of seats) {
    const moved = overrides[seat.partId];
    if (moved) {
      const place = clampToStage(venue, moved.x, moved.z, rowCount);
      seat.x = place.x;
      seat.z = place.z;
      seat.rotation = facingConductor(seat.x, seat.z);
    }
    seat.y = floorHeight(venue, seat.x, seat.z, rowCount);
  }
  return seats.sort((a, b) => a.partIndex - b.partIndex);
}

/** Whether a player of the score was moved from the standard seating (moves of deleted parts don't count). */
export function hasMovedPlayers(score: Score, overrides: Record<string, SeatOverride>): boolean {
  return score.parts.some((part) => overrides[part.id]);
}

/** The number of arcs a seating uses. */
export function rowCount(seats: Seat[]): number {
  return seats.reduce((n, s) => Math.max(n, s.row + 1), 1);
}

/** Where each part's sound comes from: the instrument of a seated player, about 1.1 m above their floor. */
export function soundPositions(seats: Seat[]): Map<string, Vec3> {
  return new Map(seats.map((s) => [s.partId, { x: s.x, y: s.y + 1.1, z: s.z }]));
}

/** Where the listener sits for stereo playback outside the stage: just behind the conductor, facing the players. */
export const STEREO_LISTENER = { position: { x: 0, y: 1.6, z: 1.5 }, forward: { x: 0, y: 0, z: -1 } };

export type ViewpointId = "overview" | "conductor" | "front-row" | "balcony" | "above" | "seat";

export interface Viewpoint {
  position: Vec3;
  target: Vec3;
}

/** Where the camera goes for each view; "seat" needs a seat (the selected player's chair). */
export function viewpoint(id: ViewpointId, venue: Venue, seats: Seat[], seat?: Seat): Viewpoint {
  const rows = rowCount(seats);
  const floor = venue === "bandstand" ? BANDSTAND_HEIGHT : 0;
  const middle = -(FIRST_ROW + ((rows - 1) * ROW_GAP) / 2);
  switch (id) {
    case "conductor":
      // At the conductor's eyes, on the podium.
      return { position: { x: 0, y: floor + 1.82, z: 0.02 }, target: { x: 0, y: floor + 0.9, z: middle } };
    case "front-row":
      return venue === "hall"
        ? { position: { x: 0, y: 0.3, z: 5.2 }, target: { x: 0, y: 1.0, z: middle } }
        : { position: { x: 0, y: 1.2, z: 7.4 }, target: { x: 0, y: floor + 1.0, z: middle } };
    case "balcony":
      return venue === "hall"
        ? { position: { x: 0, y: 6.3, z: 26 }, target: { x: 0, y: 0.3, z: middle } }
        : { position: { x: -9, y: 5.5, z: 17 }, target: { x: 0, y: floor, z: middle } };
    case "above": {
      // Straight down, from high enough to see every row (the roof and ceiling disappear above them).
      const z = venue === "bandstand" ? bandstandCenter(rows).z : middle;
      return { position: { x: 0, y: floor + 7.5 + rows * 2.2, z: z + 0.01 }, target: { x: 0, y: 0, z } };
    }
    case "seat":
      if (seat) {
        // Just in front of the player's head, looking at the conductor.
        const toward = Math.hypot(seat.x, seat.z) || 1;
        return {
          position: { x: seat.x - (seat.x / toward) * 0.25, y: seat.y + 1.3, z: seat.z - (seat.z / toward) * 0.25 },
          target: { x: 0, y: floor + 1.5, z: 0 },
        };
      }
      return viewpoint("overview", venue, seats);
    default:
      // Close enough to see the players, high enough to see the back rows.
      return { position: { x: 0, y: floor + 2.3 + rows * 0.6, z: 3.4 + rows * 1.5 }, target: { x: 0, y: floor + 0.5, z: middle } };
  }
}
