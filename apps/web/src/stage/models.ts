/**
 * Simple 3D models of the players and their instruments, built from cylinders, cones, spheres,
 * boxes and rings. Plain data, so it can be tested without WebGL; stage/scene.ts turns it into meshes.
 *
 * Each model is in the player's own frame: metres, the floor under the chair at the origin, the
 * player facing +z (towards the conductor).
 */
import { getInstrument, type InstrumentFamily } from "@musicraft/score-core";

export type MaterialName =
  | "brass"
  | "silver"
  | "black"
  | "wood"
  | "darkwood"
  | "cane"
  | "ivory"
  | "chair"
  | "skin"
  | "hair"
  | "shirt"
  | "jacket"
  | "trousers"
  | "stand"
  | "piano";

export interface Shape {
  kind: "cylinder" | "sphere" | "box" | "torus";
  /**
   * cylinder: [radius at the top, radius at the bottom, height] (along its y axis);
   * sphere: [radius]; box: [width, height, depth]; torus: [radius, tube radius, arc in degrees].
   */
  size: number[];
  position: [number, number, number];
  /** Degrees, applied in x, y, z order (three.js "XYZ"). */
  rotation?: [number, number, number];
  scale?: [number, number, number];
  material: MaterialName;
}

export interface PlayerModel {
  kind: ModelKind;
  /** Chair, player and music stand. */
  body: Shape[];
  /** The instrument (it moves a little while it plays). */
  instrument: Shape[];
  /** Where the sound (and the floating notes) come out. */
  bell: [number, number, number];
  /** Singers and double bass players stand; everyone else sits. */
  standing: boolean;
  /** Whether the player reads from a music stand (a pianist uses the piano's). */
  stand: boolean;
}

export type ModelKind =
  | "trumpet"
  | "piccolo-trumpet"
  | "cornet"
  | "flugelhorn"
  | "tenor-horn"
  | "horn"
  | "trombone"
  | "euphonium"
  | "tuba"
  | "flute"
  | "piccolo"
  | "clarinet"
  | "bass-clarinet"
  | "oboe"
  | "english-horn"
  | "bassoon"
  | "soprano-sax"
  | "alto-sax"
  | "tenor-sax"
  | "baritone-sax"
  | "violin"
  | "viola"
  | "cello"
  | "double-bass"
  | "guitar"
  | "piano"
  | "voice"
  | "generic";

const KIND_BY_INSTRUMENT: Record<string, ModelKind> = {
  "trumpet-bb": "trumpet",
  "trumpet-c": "trumpet",
  "trumpet-d": "trumpet",
  "trumpet-eb": "trumpet",
  "piccolo-trumpet-bb": "piccolo-trumpet",
  "cornet-bb": "cornet",
  "soprano-cornet-eb": "cornet",
  flugelhorn: "flugelhorn",
  "tenor-horn-eb": "tenor-horn",
  "horn-f": "horn",
  trombone: "trombone",
  "bass-trombone": "trombone",
  "baritone-tc": "euphonium",
  euphonium: "euphonium",
  "euphonium-tc": "euphonium",
  tuba: "tuba",
  "bass-eb-tc": "tuba",
  "bass-bb-tc": "tuba",
  piccolo: "piccolo",
  flute: "flute",
  oboe: "oboe",
  "english-horn": "english-horn",
  "clarinet-bb": "clarinet",
  "clarinet-a": "clarinet",
  "clarinet-eb": "clarinet",
  "bass-clarinet": "bass-clarinet",
  bassoon: "bassoon",
  "soprano-sax": "soprano-sax",
  "alto-sax": "alto-sax",
  "tenor-sax": "tenor-sax",
  "baritone-sax": "baritone-sax",
  violin: "violin",
  viola: "viola",
  cello: "cello",
  "double-bass": "double-bass",
  guitar: "guitar",
  piano: "piano",
  organ: "piano",
  soprano: "voice",
  alto: "voice",
  tenor: "voice",
  "bass-voice": "voice",
  voice: "voice",
};

export function modelKind(instrumentId: string): ModelKind {
  return KIND_BY_INSTRUMENT[instrumentId] ?? "generic";
}

type V3 = [number, number, number];

const DEG = 180 / Math.PI;

/** A cylinder (or cone) from one point to another; `rFrom`/`rTo` are its radii at either end. */
function tube(from: V3, to: V3, rFrom: number, rTo = rFrom, material: MaterialName = "brass"): Shape {
  const d: V3 = [to[0] - from[0], to[1] - from[1], to[2] - from[2]];
  const length = Math.hypot(...d);
  const [dx, dy, dz] = d.map((c) => c / length) as V3;
  // Turn the cylinder's y axis onto d: about z by γ, then about x by α (three.js "XYZ" order).
  const gamma = Math.asin(Math.max(-1, Math.min(1, -dx)));
  const alpha = Math.cos(gamma) > 1e-6 ? Math.atan2(dz, dy) : 0;
  return {
    kind: "cylinder",
    size: [rTo, rFrom, length],
    position: [(from[0] + to[0]) / 2, (from[1] + to[1]) / 2, (from[2] + to[2]) / 2],
    rotation: [alpha * DEG, 0, gamma * DEG],
    material,
  };
}

/** A bell: a cone flaring from its throat to its mouth. */
function bell(throat: V3, mouth: V3, mouthRadius: number, throatRadius = 0.012, material: MaterialName = "brass"): Shape {
  return tube(throat, mouth, throatRadius, mouthRadius, material);
}

function box(size: V3, position: V3, material: MaterialName, rotation?: V3): Shape {
  return { kind: "box", size, position, material, ...(rotation ? { rotation } : {}) };
}

function sphere(radius: number, position: V3, material: MaterialName, scale?: V3): Shape {
  return { kind: "sphere", size: [radius], position, material, ...(scale ? { scale } : {}) };
}

/** A seated or standing player in concert dress, facing +z (the conductor's baton arm is left out and animated). */
function figure(standing: boolean, rightArm = true): Shape[] {
  if (standing) {
    return [
      tube([-0.1, 0, 0], [-0.1, 0.85, 0], 0.065, 0.07, "trousers"),
      tube([0.1, 0, 0], [0.1, 0.85, 0], 0.065, 0.07, "trousers"),
      tube([0, 0.85, 0], [0, 1.42, 0], 0.17, 0.2, "jacket"),
      box([0.09, 0.2, 0.02], [0, 1.3, 0.18], "shirt"),
      ...(rightArm ? [tube([-0.21, 1.38, 0], [-0.24, 1.08, 0.12], 0.05, 0.045, "jacket")] : []),
      tube([0.21, 1.38, 0], [0.24, 1.08, 0.12], 0.05, 0.045, "jacket"),
      sphere(0.11, [0, 1.6, 0.01], "skin"),
      sphere(0.115, [0, 1.65, -0.02], "hair", [1, 0.7, 1]),
    ];
  }
  return [
    // thighs, shins
    tube([-0.1, 0.5, -0.05], [-0.1, 0.5, 0.33], 0.065, 0.06, "trousers"),
    tube([0.1, 0.5, -0.05], [0.1, 0.5, 0.33], 0.065, 0.06, "trousers"),
    tube([-0.1, 0.5, 0.33], [-0.1, 0.05, 0.36], 0.055, 0.05, "trousers"),
    tube([0.1, 0.5, 0.33], [0.1, 0.05, 0.36], 0.055, 0.05, "trousers"),
    // torso, shirt front, arms, head and hair
    tube([0, 0.5, -0.03], [0, 1.05, -0.01], 0.17, 0.19, "jacket"),
    box([0.09, 0.2, 0.02], [0, 0.94, 0.17], "shirt"),
    tube([-0.21, 1.0, -0.01], [-0.2, 0.86, 0.2], 0.05, 0.045, "jacket"),
    tube([0.21, 1.0, -0.01], [0.2, 0.86, 0.2], 0.05, 0.045, "jacket"),
    sphere(0.11, [0, 1.2, 0.0], "skin"),
    sphere(0.115, [0, 1.25, -0.03], "hair", [1, 0.7, 1]),
  ];
}

function chair(): Shape[] {
  return [
    box([0.44, 0.05, 0.42], [0, 0.45, -0.02], "chair"),
    box([0.44, 0.42, 0.04], [0, 0.7, -0.23], "chair"),
    tube([-0.19, 0, 0.17], [-0.19, 0.43, 0.17], 0.015, 0.015, "stand"),
    tube([0.19, 0, 0.17], [0.19, 0.43, 0.17], 0.015, 0.015, "stand"),
    tube([-0.19, 0, -0.21], [-0.19, 0.43, -0.21], 0.015, 0.015, "stand"),
    tube([0.19, 0, -0.21], [0.19, 0.43, -0.21], 0.015, 0.015, "stand"),
  ];
}

/**
 * A music stand in front of the player, its desk tilted towards them; `x` moves it to the side
 * (brass players keep their bell or slide clear of it).
 */
export function musicStand(x = 0.3): Shape[] {
  return [
    tube([x, 0, 0.7], [x, 1.0, 0.7], 0.012, 0.012, "stand"),
    tube([x, 0.02, 0.7], [x + 0.18, 0, 0.78], 0.01, 0.01, "stand"),
    tube([x, 0.02, 0.7], [x - 0.18, 0, 0.78], 0.01, 0.01, "stand"),
    tube([x, 0.02, 0.7], [x, 0, 0.5], 0.01, 0.01, "stand"),
    box([0.5, 0.36, 0.015], [x, 1.08, 0.68], "stand", [-25, -12, 0]),
    // the sheet of music on it
    box([0.44, 0.3, 0.004], [x, 1.085, 0.67], "ivory", [-25, -12, 0]),
  ];
}

/** The instrument a player holds, and where its sound comes out. */
function instrument(kind: ModelKind): { shapes: Shape[]; bell: V3 } {
  switch (kind) {
    case "trumpet":
    case "piccolo-trumpet": {
      const s = kind === "piccolo-trumpet" ? 0.7 : 1;
      const mouth: V3 = [0, 1.17, 0.1];
      const end: V3 = [0, 1.12, 0.1 + 0.42 * s];
      return {
        shapes: [
          tube(mouth, end, 0.009, 0.012),
          tube([0, 1.07, 0.16], [0, 1.07, 0.1 + 0.36 * s], 0.012),
          tube([0, 1.07, 0.16], [0, 1.12, 0.16], 0.012),
          ...[0.2, 0.235, 0.27].map((z) => tube([0, 1.04, 0.1 + (z - 0.1) * s], [0, 1.15, 0.1 + (z - 0.1) * s], 0.011, 0.011, "silver")),
          bell(end, [0, 1.11, end[2] + 0.15 * s], 0.065 * s),
        ],
        bell: [0, 1.11, end[2] + 0.15 * s],
      };
    }
    case "cornet":
    case "flugelhorn": {
      const wide = kind === "flugelhorn";
      return {
        shapes: [
          tube([0, 1.17, 0.1], [0, 1.12, 0.32], 0.009, 0.014),
          tube([0, 1.06, 0.15], [0, 1.06, 0.3], 0.014),
          tube([0, 1.06, 0.15], [0, 1.12, 0.15], 0.013),
          ...[0.2, 0.235, 0.27].map((z) => tube([0, 1.04, z], [0, 1.15, z], 0.011, 0.011, "silver")),
          bell([0, 1.12, 0.32], [0, 1.1, wide ? 0.55 : 0.47], wide ? 0.085 : 0.06, wide ? 0.02 : 0.013),
        ],
        bell: [0, 1.1, wide ? 0.55 : 0.47],
      };
    }
    case "tenor-horn":
    case "euphonium":
    case "tuba": {
      const s = kind === "tenor-horn" ? 1 : kind === "euphonium" ? 1.3 : 1.85;
      const base: V3 = [0.06, 0.78, 0.22];
      const top: V3 = [0.06 + 0.02 * s, 0.78 + 0.33 * s, 0.22];
      return {
        shapes: [
          tube(base, top, 0.045 * s, 0.05 * s),
          { kind: "torus", size: [0.05 * s, 0.022 * s, 180], position: [0.06, 0.78, 0.22], rotation: [0, 90, 180], material: "brass" },
          bell(top, [top[0] + 0.03 * s, top[1] + 0.16 * s, top[2]], 0.085 * s, 0.05 * s),
          tube([0, 1.17, 0.1], [0.03, 1.06, 0.2], 0.008, 0.012),
          ...[0, 1, 2].map((i) => tube([-0.01 * s, 0.86 + i * 0.045 * s, 0.24], [0.04, 0.86 + i * 0.045 * s, 0.24], 0.011 * s, 0.011 * s, "silver")),
        ],
        bell: [top[0] + 0.03 * s, top[1] + 0.16 * s, top[2]],
      };
    }
    case "horn":
      return {
        shapes: [
          { kind: "torus", size: [0.15, 0.018, 360], position: [0.17, 0.95, 0.14], rotation: [0, 90, 0], material: "brass" },
          { kind: "torus", size: [0.1, 0.012, 360], position: [0.17, 0.95, 0.14], rotation: [0, 90, 0], material: "brass" },
          tube([0, 1.17, 0.1], [0.17, 1.05, 0.22], 0.008, 0.012),
          bell([0.2, 0.84, 0.05], [0.3, 0.74, -0.12], 0.13, 0.03),
        ],
        bell: [0.3, 0.74, -0.12],
      };
    case "trombone":
      return {
        shapes: [
          tube([-0.035, 1.12, 0.1], [-0.035, 1.05, 0.92], 0.01, 0.01),
          tube([0.035, 1.12, 0.1], [0.035, 1.05, 0.92], 0.01, 0.01),
          tube([-0.035, 1.05, 0.92], [0.035, 1.05, 0.92], 0.012, 0.012),
          tube([-0.035, 1.1, 0.4], [0.035, 1.1, 0.4], 0.008, 0.008),
          tube([0.035, 1.17, 0.08], [0.12, 1.2, -0.05], 0.014, 0.014),
          bell([0.12, 1.17, 0.12], [0.12, 1.13, 0.52], 0.1, 0.02),
        ],
        bell: [0.12, 1.13, 0.52],
      };
    case "flute":
    case "piccolo": {
      const length = kind === "piccolo" ? 0.32 : 0.66;
      return {
        shapes: [tube([-0.06, 1.17, 0.12], [-0.06 + length, 1.15, 0.16], 0.011, 0.011, "silver")],
        bell: [-0.06 + length, 1.15, 0.16],
      };
    }
    case "clarinet":
    case "oboe":
    case "english-horn":
    case "bass-clarinet":
    case "soprano-sax": {
      const long = kind === "bass-clarinet" ? 0.95 : kind === "english-horn" ? 0.75 : 0.62;
      const material: MaterialName = kind === "soprano-sax" ? "brass" : "black";
      const top: V3 = [0, 1.15, 0.1];
      const bottom: V3 = [0, 1.15 - long * 0.84, 0.1 + long * 0.54];
      const shapes: Shape[] = [tube(top, bottom, 0.013, kind === "soprano-sax" ? 0.025 : 0.017, material)];
      // A bass clarinet's bell curves up and forward; the others point down.
      const mouth: V3 = kind === "bass-clarinet" ? [bottom[0], bottom[1] + 0.07, bottom[2] + 0.09] : [bottom[0], bottom[1] - 0.06, bottom[2] + 0.04];
      if (kind === "english-horn") shapes.push(sphere(0.03, bottom, "black"));
      else shapes.push(bell(bottom, mouth, kind === "oboe" ? 0.027 : kind === "bass-clarinet" ? 0.06 : 0.04, 0.017, kind === "bass-clarinet" ? "silver" : material));
      if (kind === "clarinet" || kind === "bass-clarinet") {
        shapes.push(tube([0, top[1] - 0.2, top[2] + 0.13], [0, top[1] - 0.22, top[2] + 0.14], 0.016, 0.016, "silver"));
      }
      return { shapes, bell: mouth };
    }
    case "bassoon":
      return {
        shapes: [
          tube([0.24, 0.42, 0.18], [-0.2, 1.62, 0.1], 0.036, 0.034, "darkwood"),
          tube([0.24, 0.42, 0.18], [0.26, 0.6, 0.2], 0.03, 0.03, "darkwood"),
          tube([0.02, 1.1, 0.15], [0, 1.16, 0.1], 0.006, 0.006, "silver"),
        ],
        bell: [-0.2, 1.62, 0.1],
      };
    case "alto-sax":
    case "tenor-sax":
    case "baritone-sax": {
      const s = kind === "alto-sax" ? 1 : kind === "tenor-sax" ? 1.22 : 1.55;
      const top: V3 = [0.02, 1.08, 0.2];
      const bottom: V3 = [0.08, 1.08 - 0.42 * s, 0.24];
      return {
        shapes: [
          tube([0, 1.16, 0.1], top, 0.008, 0.015),
          tube(top, bottom, 0.02 * s, 0.035 * s),
          { kind: "torus", size: [0.045 * s, 0.035 * s, 180], position: [bottom[0] + 0.045 * s, bottom[1], bottom[2]], rotation: [0, 0, 180], material: "brass" },
          bell([bottom[0] + 0.09 * s, bottom[1], bottom[2]], [bottom[0] + 0.1 * s, bottom[1] + 0.2 * s, bottom[2] + 0.04], 0.065 * s, 0.035 * s),
        ],
        bell: [bottom[0] + 0.1 * s, bottom[1] + 0.2 * s, bottom[2] + 0.04],
      };
    }
    case "violin":
    case "viola": {
      const s = kind === "viola" ? 1.15 : 1;
      return {
        shapes: [
          sphere(1, [-0.16, 1.06, 0.2], "wood", [0.1 * s, 0.03 * s, 0.17 * s]),
          box([0.03, 0.02, 0.3 * s], [-0.25, 1.09, 0.38], "black", [0, -25, 0]),
          tube([0.25, 0.98, 0.24], [-0.32, 1.12, 0.34], 0.005, 0.005, "darkwood"),
        ],
        bell: [-0.16, 1.1, 0.2],
      };
    }
    case "cello":
    case "double-bass": {
      const s = kind === "double-bass" ? 1.4 : 1;
      const y = kind === "double-bass" ? 0.95 : 0.72;
      return {
        shapes: [
          sphere(1, [0, y, 0.38], "wood", [0.22 * s, 0.36 * s, 0.11 * s]),
          box([0.05, 0.55 * s, 0.03], [0, y + 0.55 * s, 0.36], "black"),
          tube([0, y - 0.35 * s, 0.4], [0, 0, 0.45], 0.008, 0.008, "silver"),
          tube([0.35, y - 0.02, 0.5], [-0.3, y + 0.05, 0.5], 0.005, 0.005, "darkwood"),
        ],
        bell: [0, y + 0.1, 0.45],
      };
    }
    case "guitar":
      return {
        shapes: [
          sphere(1, [0.08, 0.72, 0.18], "wood", [0.2, 0.15, 0.05]),
          box([0.45, 0.05, 0.03], [-0.25, 0.86, 0.2], "darkwood", [0, 0, 18]),
        ],
        bell: [0.08, 0.72, 0.24],
      };
    case "piano":
      return {
        shapes: [
          box([1.5, 0.3, 1.45], [0, 0.85, 1.1], "piano"),
          box([1.5, 0.03, 0.2], [0, 0.75, 0.32], "piano"),
          box([1.32, 0.025, 0.15], [0, 0.775, 0.33], "ivory"),
          box([1.3, 0.02, 0.07], [0, 0.79, 0.37], "black"),
          box([1.5, 0.02, 1.35], [0.32, 1.32, 1.1], "piano", [0, 0, 32]),
          box([0.6, 0.3, 0.015], [0, 1.02, 0.42], "piano", [-15, 0, 0]),
          tube([-0.65, 0, 0.45], [-0.65, 0.7, 0.45], 0.04, 0.04, "piano"),
          tube([0.65, 0, 0.45], [0.65, 0.7, 0.45], 0.04, 0.04, "piano"),
          tube([0, 0, 1.75], [0, 0.7, 1.75], 0.04, 0.04, "piano"),
        ],
        bell: [0.2, 1.2, 1.1],
      };
    case "voice":
      return { shapes: [box([0.24, 0.31, 0.012], [0, 1.18, 0.26], "black", [-55, 0, 0])], bell: [0, 1.62, 0.12] };
    default:
      return { shapes: [], bell: [0, 1.15, 0.3] };
  }
}

/** A player with their instrument (and chair and music stand). */
export function playerModel(instrumentId: string): PlayerModel {
  const kind = modelKind(instrumentId);
  const standing = kind === "voice" || kind === "double-bass";
  const stand = kind !== "piano" && kind !== "voice";
  const held = instrument(kind);
  const seat = standing ? [] : kind === "piano" ? [box([0.6, 0.06, 0.32], [0, 0.48, -0.02], "piano")] : chair();
  return { kind, body: [...seat, ...figure(standing), ...(stand ? musicStand() : [])], instrument: held.shapes, bell: held.bell, standing, stand };
}

/** The conductor: standing, without the right arm (the baton arm is animated separately). */
export function conductorModel(): Shape[] {
  return figure(true, false);
}

/** The conductor's right shoulder, where the baton arm hangs. */
export const CONDUCTOR_SHOULDER: [number, number, number] = [-0.21, 1.38, 0];

/** A colour per family, for the glow under a player and their name card. */
export const FAMILY_COLORS: Record<InstrumentFamily, string> = {
  brass: "#f2b632",
  woodwind: "#4fb3a9",
  strings: "#c8763f",
  keyboard: "#8f7ae6",
  voice: "#e46a8c",
  other: "#9aa5b1",
};

export function familyColor(instrumentId: string): string {
  return FAMILY_COLORS[getInstrument(instrumentId).family] ?? FAMILY_COLORS.other;
}
