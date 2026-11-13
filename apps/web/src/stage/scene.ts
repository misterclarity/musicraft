/**
 * A-Frame components of the stage, built with three.js: the venue, the players, the conductor and
 * the camera. Imported (after A-Frame) only by the stage view, so none of this loads until it opens.
 */
import AFRAME, { type Component, type Entity } from "aframe";
import * as THREE from "three";
import { beatAt, live } from "./activity";
import { BANDSTAND_HEIGHT, bandstandCenter, bandstandRadius, FIRST_ROW, RISER_STEP, ROW_GAP } from "./layout";
import { CONDUCTOR_SHOULDER, conductorModel, musicStand, playerModel, type MaterialName, type Shape } from "./models";
import { players, stageState, type PlayerInfo } from "./registry";
import { usePlayback } from "../state/playback";

const { mergeGeometries } = AFRAME.THREE.BufferGeometryUtils;
const DEG = Math.PI / 180;

/** Register a component once (a hot reload in development runs this module again). */
function register<T>(name: string, definition: Record<string, unknown> & ThisType<T>) {
  if (!(name in AFRAME.components)) AFRAME.registerComponent(name, definition);
}

// ---------------------------------------------------------------------------------------------
// Materials and geometry

const MATERIAL_SPECS: Record<MaterialName, THREE.MeshStandardMaterialParameters> = {
  brass: { color: 0xd9a93a, metalness: 0.55, roughness: 0.28 },
  silver: { color: 0xd3d7de, metalness: 0.6, roughness: 0.25 },
  black: { color: 0x1c1c20, metalness: 0.1, roughness: 0.45 },
  wood: { color: 0x9b5a2a, roughness: 0.45 },
  darkwood: { color: 0x5e3418, roughness: 0.5 },
  cane: { color: 0xd8c08a, roughness: 0.7 },
  ivory: { color: 0xf4f0e6, roughness: 0.5 },
  chair: { color: 0x30343c, roughness: 0.8 },
  skin: { color: 0xd8ab8c, roughness: 0.85 },
  hair: { color: 0x3a2a20, roughness: 0.9 },
  shirt: { color: 0xf2f2f2, roughness: 0.8 },
  jacket: { color: 0x23252b, roughness: 0.75 },
  trousers: { color: 0x1b1c20, roughness: 0.8 },
  stand: { color: 0x26272b, metalness: 0.4, roughness: 0.5 },
  piano: { color: 0x0d0d10, metalness: 0.2, roughness: 0.15 },
};

const materials = new Map<string, THREE.Material>();

function material(name: MaterialName): THREE.Material {
  let found = materials.get(name);
  if (!found) {
    found = new THREE.MeshStandardMaterial(MATERIAL_SPECS[name]);
    materials.set(name, found);
  }
  return found;
}

function standard(color: THREE.ColorRepresentation, extra: THREE.MeshStandardMaterialParameters = {}): THREE.MeshStandardMaterial {
  const key = `std:${String(color)}:${JSON.stringify(extra)}`;
  let found = materials.get(key) as THREE.MeshStandardMaterial | undefined;
  if (!found) {
    found = new THREE.MeshStandardMaterial({ color, roughness: 0.8, ...extra });
    materials.set(key, found);
  }
  return found;
}

function shapeGeometry(shape: Shape): THREE.BufferGeometry {
  const [a = 0, b = 0, c = 0] = shape.size;
  switch (shape.kind) {
    case "cylinder":
      return new THREE.CylinderGeometry(a, b, c, 14);
    case "sphere":
      return new THREE.SphereGeometry(a, 16, 12);
    case "box":
      return new THREE.BoxGeometry(a, b, c);
    case "torus":
      return new THREE.TorusGeometry(a, b, 10, 28, c * DEG);
  }
}

/** Every shape as one geometry per material, already in place: a few draw calls per player instead of dozens. */
function mergeShapes(shapes: Shape[]): Map<MaterialName, THREE.BufferGeometry> {
  const byMaterial = new Map<MaterialName, THREE.BufferGeometry[]>();
  const matrix = new THREE.Matrix4();
  const quaternion = new THREE.Quaternion();
  for (const shape of shapes) {
    const geometry = shapeGeometry(shape);
    const rotation = shape.rotation ?? [0, 0, 0];
    quaternion.setFromEuler(new THREE.Euler(rotation[0] * DEG, rotation[1] * DEG, rotation[2] * DEG, "XYZ"));
    matrix.compose(new THREE.Vector3(...shape.position), quaternion, new THREE.Vector3(...(shape.scale ?? [1, 1, 1])));
    geometry.applyMatrix4(matrix);
    const list = byMaterial.get(shape.material) ?? [];
    list.push(geometry.index ? geometry.toNonIndexed() : geometry);
    byMaterial.set(shape.material, list);
  }
  const merged = new Map<MaterialName, THREE.BufferGeometry>();
  for (const [name, list] of byMaterial) {
    const geometry = mergeGeometries(list);
    if (geometry) merged.set(name, geometry);
  }
  return merged;
}

/** Merged models are shared by every player of the same instrument. */
const modelCache = new Map<string, { body: Map<MaterialName, THREE.BufferGeometry>; instrument: Map<MaterialName, THREE.BufferGeometry>; bell: THREE.Vector3; standing: boolean }>();

function cachedModel(instrumentId: string) {
  let model = modelCache.get(instrumentId);
  if (!model) {
    const built = playerModel(instrumentId);
    model = { body: mergeShapes(built.body), instrument: mergeShapes(built.instrument), bell: new THREE.Vector3(...built.bell), standing: built.standing };
    modelCache.set(instrumentId, model);
  }
  return model;
}

function meshes(geometries: Map<MaterialName, THREE.BufferGeometry>, shadows = true): THREE.Group {
  const group = new THREE.Group();
  for (const [name, geometry] of geometries) {
    const mesh = new THREE.Mesh(geometry, material(name));
    mesh.castShadow = shadows;
    mesh.receiveShadow = shadows;
    group.add(mesh);
  }
  return group;
}

// ---------------------------------------------------------------------------------------------
// Text

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

const FONT = "system-ui, -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif";

/** A player's name card: the part name, a stripe in the family colour, and muted/solo state. */
function drawNameCard(canvas: HTMLCanvasElement, info: PlayerInfo) {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const { width, height } = canvas;
  ctx.clearRect(0, 0, width, height);
  roundRect(ctx, 4, 4, width - 8, height - 8, 26);
  ctx.fillStyle = info.selected ? "rgba(28,126,214,0.92)" : info.hovered ? "rgba(70,74,86,0.92)" : "rgba(18,20,26,0.78)";
  ctx.fill();
  ctx.fillStyle = info.audible ? info.color : "#6b7280";
  roundRect(ctx, 4, 4, 22, height - 8, 11);
  ctx.fill();
  const status = !info.audible ? "muted" : info.solo ? "solo" : "";
  ctx.font = `600 46px ${FONT}`;
  ctx.textBaseline = "middle";
  ctx.fillStyle = info.audible ? "#ffffff" : "#9ca3af";
  const right = status ? 150 : 30;
  let text = info.label;
  while (ctx.measureText(text).width > width - 50 - right && text.length > 3) text = `${text.slice(0, -2)}…`;
  ctx.fillText(text, 44, height / 2 + 2);
  if (status) {
    ctx.font = `600 32px ${FONT}`;
    ctx.fillStyle = info.solo ? "#ffd43b" : "#9ca3af";
    ctx.textAlign = "right";
    ctx.fillText(status, width - 26, height / 2 + 2);
    ctx.textAlign = "left";
  }
}

let noteTexture: THREE.Texture | null = null;

/** A floating note, drawn once. */
function noteGlyph(): THREE.Texture {
  if (!noteTexture) {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 64;
    const ctx = canvas.getContext("2d")!;
    ctx.fillStyle = "#ffffff";
    // An eighth note: head, stem and flag.
    ctx.beginPath();
    ctx.ellipse(24, 46, 12, 9, -0.4, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillRect(33, 10, 5, 37);
    ctx.beginPath();
    ctx.moveTo(38, 10);
    ctx.quadraticCurveTo(54, 18, 50, 34);
    ctx.quadraticCurveTo(48, 24, 38, 22);
    ctx.fill();
    noteTexture = new THREE.CanvasTexture(canvas);
    noteTexture.colorSpace = THREE.SRGBColorSpace;
  }
  return noteTexture;
}

// ---------------------------------------------------------------------------------------------
// Players

interface Particle {
  sprite: THREE.Sprite;
  born: number;
  drift: number;
}

interface PlayerComponent extends Component<{ part: string; v: number }> {
  root: THREE.Group;
  model: THREE.Group | null;
  instrumentGroup: THREE.Group | null;
  instrumentId: string;
  bell: THREE.Vector3;
  glow: THREE.Mesh<THREE.RingGeometry, THREE.MeshBasicMaterial>;
  ring: THREE.Mesh<THREE.RingGeometry, THREE.MeshBasicMaterial>;
  label: THREE.Sprite;
  labelCanvas: HTMLCanvasElement;
  labelTexture: THREE.CanvasTexture;
  meter: THREE.Group;
  marker: THREE.Mesh<THREE.SphereGeometry, THREE.MeshBasicMaterial>;
  meterKey: string;
  particles: Particle[];
  lastOnset: number;
  level: number;
  info: PlayerInfo | undefined;
  spawnNote(time: number, color: string): void;
}

const RING = new THREE.RingGeometry(0.52, 0.64, 48);
const SELECT_RING = new THREE.RingGeometry(0.68, 0.75, 48);
const MARKER = new THREE.SphereGeometry(0.035, 12, 8);
const METER_X = -0.48;
const METER_Z = 0.3;
const METER_BOTTOM = 0.3;
const METER_HEIGHT = 1.0;

function meterY(midi: number, info: PlayerInfo): number {
  const { rangeLow, rangeHigh } = info.range;
  const t = (midi - rangeLow) / Math.max(1, rangeHigh - rangeLow);
  return METER_BOTTOM + Math.max(-0.05, Math.min(1.05, t)) * METER_HEIGHT;
}

function bar(from: number, to: number, width: number, mat: THREE.Material): THREE.Mesh {
  const height = Math.max(0.01, to - from);
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(width, height, width), mat);
  mesh.position.set(METER_X, from + height / 2, METER_Z);
  return mesh;
}

function buildMeter(info: PlayerInfo): THREE.Group {
  const group = new THREE.Group();
  const { range } = info;
  group.add(bar(METER_BOTTOM, METER_BOTTOM + METER_HEIGHT, 0.03, standard(0x3a3d45, { roughness: 0.6 })));
  group.add(bar(meterY(range.comfortLow, info), meterY(range.comfortHigh, info), 0.045, standard(0x37b24d, { transparent: true, opacity: 0.75 })));
  if (range.low !== null && range.high !== null) {
    const color = range.beyond === "range" ? 0xfa5252 : range.beyond === "comfort" ? 0xfd7e14 : 0xf8f9fa;
    group.add(bar(meterY(range.low, info) - 0.012, meterY(range.high, info) + 0.012, 0.06, standard(color, { emissive: color, emissiveIntensity: 0.35, transparent: true, opacity: 0.85 })));
  }
  return group;
}

register<PlayerComponent>("mc-player", {
  schema: { part: { type: "string" }, v: { type: "int", default: 0 } },

  init() {
    this.root = new THREE.Group();
    this.model = null;
    this.instrumentGroup = null;
    this.instrumentId = "";
    this.bell = new THREE.Vector3();
    this.particles = [];
    this.lastOnset = -1;
    this.level = 0;
    this.meterKey = "";

    this.glow = new THREE.Mesh(RING, new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.12, depthWrite: false, side: THREE.DoubleSide }));
    this.glow.rotation.x = -Math.PI / 2;
    this.glow.position.y = 0.015;
    this.root.add(this.glow);

    this.ring = new THREE.Mesh(SELECT_RING, new THREE.MeshBasicMaterial({ color: 0x339af0, transparent: true, opacity: 0.95, depthWrite: false, side: THREE.DoubleSide }));
    this.ring.rotation.x = -Math.PI / 2;
    this.ring.position.y = 0.016;
    this.ring.visible = false;
    this.root.add(this.ring);

    this.labelCanvas = document.createElement("canvas");
    this.labelCanvas.width = 512;
    this.labelCanvas.height = 104;
    this.labelTexture = new THREE.CanvasTexture(this.labelCanvas);
    this.labelTexture.colorSpace = THREE.SRGBColorSpace;
    this.labelTexture.anisotropy = 4;
    this.label = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.labelTexture, transparent: true, depthWrite: false }));
    this.label.scale.set(0.9, 0.183, 1);
    this.label.renderOrder = 2;
    this.root.add(this.label);

    this.meter = new THREE.Group();
    this.root.add(this.meter);
    this.marker = new THREE.Mesh(MARKER, new THREE.MeshBasicMaterial({ color: 0xffd43b }));
    this.marker.position.set(METER_X, 0, METER_Z);
    this.marker.visible = false;
    this.root.add(this.marker);

    this.el.setObject3D("mesh", this.root);
  },

  update() {
    const info = players.get(this.data.part);
    this.info = info;
    if (!info) return;
    if (info.instrument !== this.instrumentId) {
      if (this.model) this.root.remove(this.model);
      if (this.instrumentGroup) this.root.remove(this.instrumentGroup);
      const model = cachedModel(info.instrument);
      this.model = meshes(model.body);
      this.instrumentGroup = meshes(model.instrument);
      this.root.add(this.model, this.instrumentGroup);
      this.bell.copy(model.bell);
      this.label.position.set(0, model.standing ? 2.0 : 1.62, 0);
      this.instrumentId = info.instrument;
    }
    this.glow.material.color.set(info.audible ? info.color : "#868e96");
    this.ring.visible = info.selected || info.hovered;
    this.ring.material.color.set(info.selected ? "#339af0" : "#adb5bd");
    this.label.visible = info.showName || info.selected || info.hovered;
    drawNameCard(this.labelCanvas, info);
    this.labelTexture.needsUpdate = true;

    const meterKey = info.showMeter ? JSON.stringify(info.range) : "";
    if (meterKey !== this.meterKey) {
      this.root.remove(this.meter);
      this.meter.traverse((o) => (o as THREE.Mesh).geometry?.dispose());
      this.meter = info.showMeter ? buildMeter(info) : new THREE.Group();
      this.root.add(this.meter);
      this.meterKey = meterKey;
    }
  },

  tick(time: number, delta: number) {
    const info = this.info;
    if (!info) return;
    const activity = live.parts.get(info.partId);
    const target = activity ? 0.3 + 0.7 * activity.level : 0;
    // Light up quickly, fade a little slower: per 60th of a second, half or an eighth of the way,
    // at any frame rate.
    const rate = target > this.level ? 0.5 : 0.12;
    this.level += (target - this.level) * (1 - Math.pow(1 - rate, (delta || 16.7) / 16.7));
    this.glow.material.opacity = (info.audible ? 0.14 : 0.06) + 0.8 * this.level;
    this.glow.scale.setScalar(1 + 0.12 * this.level);
    if (this.instrumentGroup) this.instrumentGroup.position.y = activity ? 0.006 * Math.sin(time / 90) * activity.level : 0;

    if (info.showMeter && activity?.midi != null) {
      const written = activity.midi - info.range.transposition;
      this.marker.visible = true;
      this.marker.position.y = meterY(written, info);
      const outside = written < info.range.comfortLow || written > info.range.comfortHigh;
      this.marker.material.color.set(outside ? "#ff6b6b" : "#ffd43b");
    } else {
      this.marker.visible = false;
    }

    if (activity && activity.onset !== this.lastOnset && live.playing) {
      this.lastOnset = activity.onset;
      this.spawnNote(time, info.color);
    }
    for (let i = this.particles.length - 1; i >= 0; i--) {
      const particle = this.particles[i]!;
      const age = (time - particle.born) / 1400;
      if (age >= 1) {
        this.root.remove(particle.sprite);
        particle.sprite.material.dispose();
        this.particles.splice(i, 1);
        continue;
      }
      particle.sprite.position.set(this.bell.x + particle.drift * age, this.bell.y + 0.08 + age * 0.75, this.bell.z);
      particle.sprite.material.opacity = (1 - age) * 0.95;
    }
  },

  spawnNote(time: number, color: string) {
    if (this.particles.length >= 5) {
      const oldest = this.particles.shift()!;
      this.root.remove(oldest.sprite);
      oldest.sprite.material.dispose();
    }
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: noteGlyph(), color, transparent: true, depthWrite: false }));
    sprite.scale.setScalar(0.16);
    this.root.add(sprite);
    this.particles.push({ sprite, born: time, drift: (Math.random() - 0.5) * 0.3 });
  },

  remove() {
    this.labelTexture.dispose();
    this.label.material.dispose();
    this.glow.material.dispose();
    this.ring.material.dispose();
    this.marker.material.dispose();
    for (const particle of this.particles) particle.sprite.material.dispose();
    this.meter.traverse((o) => (o as THREE.Mesh).geometry?.dispose());
    this.el.removeObject3D("mesh");
  },
});

const HITBOX = new THREE.CylinderGeometry(0.55, 0.55, 1.8, 12);
const INVISIBLE = new THREE.MeshBasicMaterial({ visible: false });

/** An invisible column around a player that the mouse (or a VR controller) can point at. */
register<Component>("mc-hitbox", {
  init() {
    const mesh = new THREE.Mesh(HITBOX, INVISIBLE);
    mesh.position.y = 0.9;
    this.el.setObject3D("mesh", mesh);
  },
  remove() {
    this.el.removeObject3D("mesh");
  },
});

// ---------------------------------------------------------------------------------------------
// The conductor

interface ConductorComponent extends Component<{ v: number }> {
  arm: THREE.Group;
  body: THREE.Group;
}

register<ConductorComponent>("mc-conductor", {
  schema: { v: { type: "int", default: 0 } },
  init() {
    const root = new THREE.Group();
    const podium = new THREE.Mesh(new THREE.BoxGeometry(0.95, 0.2, 0.95), standard(0x3b2a1e, { roughness: 0.6 }));
    podium.position.y = 0.1;
    podium.castShadow = podium.receiveShadow = true;
    root.add(podium);
    // The conductor faces the players (towards -z), standing on the podium.
    const body = new THREE.Group();
    this.body = body;
    body.position.y = 0.2;
    body.rotation.y = Math.PI;
    body.add(meshes(mergeShapes(conductorModel())));
    this.arm = new THREE.Group();
    this.arm.position.set(...CONDUCTOR_SHOULDER);
    const sleeve = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.05, 0.42, 10), material("jacket"));
    sleeve.position.set(0, -0.12, 0.17);
    sleeve.rotation.x = 70 * DEG;
    const baton = new THREE.Mesh(new THREE.CylinderGeometry(0.004, 0.007, 0.42, 6), material("ivory"));
    baton.position.set(0, 0.0, 0.52);
    baton.rotation.x = 80 * DEG;
    this.arm.add(sleeve, baton);
    body.add(this.arm);
    root.add(body);
    // The score desk in front of the podium.
    const desk = meshes(mergeShapes(musicStand(0)));
    desk.position.set(0, 0.2, -0.05);
    desk.rotation.y = Math.PI;
    desk.scale.setScalar(1.05);
    root.add(desk);
    this.el.setObject3D("mesh", root);
  },
  tick() {
    // From the conductor's viewpoint you are the conductor: hide the figure.
    const camera = this.el.sceneEl?.camera;
    if (camera) {
      const eye = new THREE.Vector3().setFromMatrixPosition(camera.matrixWorld);
      const head = new THREE.Vector3(0, 1.8, 0).applyMatrix4(this.el.object3D.matrixWorld);
      this.body.visible = eye.distanceTo(head) > 0.7;
    }
    const { score, performance } = stageState;
    const beat = live.playing && score && performance ? beatAt(score, performance, live.time) : null;
    // A bounce on every beat: down to the beat, then up again.
    const lift = beat ? Math.pow(1 - beat.phase, 2.4) : 0.3;
    this.arm.rotation.x = (-38 + 55 * lift) * DEG;
    this.arm.rotation.z = beat ? (beat.beats > 1 ? Math.sin((beat.beat / beat.beats) * Math.PI * 2) * 12 : 0) * DEG : 0;
  },
  remove() {
    this.el.removeObject3D("mesh");
  },
});

// ---------------------------------------------------------------------------------------------
// Venues

interface VenueComponent extends Component<{ type: string; rows: number }> {
  group: THREE.Group | null;
  owned: THREE.BufferGeometry[];
  /** Ceilings and roofs, hidden while the camera is above them (the view from above). */
  overhead: { object: THREE.Object3D; below: number }[];
}

function box(w: number, h: number, d: number, mat: THREE.Material, x: number, y: number, z: number, owned: THREE.BufferGeometry[]): THREE.Mesh {
  const geometry = new THREE.BoxGeometry(w, h, d);
  owned.push(geometry);
  const mesh = new THREE.Mesh(geometry, mat);
  mesh.position.set(x, y, z);
  mesh.castShadow = mesh.receiveShadow = true;
  return mesh;
}

function lights(group: THREE.Group, kind: "hall" | "bandstand", rows: number) {
  const depth = FIRST_ROW + rows * ROW_GAP;
  if (kind === "hall") {
    group.add(new THREE.HemisphereLight(0xfff4e8, 0x2b1d14, 0.9));
    const key = new THREE.DirectionalLight(0xfff0dc, 2.2);
    key.position.set(3, 12, 7);
    key.target.position.set(0, 0, -depth / 2);
    group.add(key, key.target);
    configureShadow(key, depth);
    const fill = new THREE.SpotLight(0xffe2bf, 22, 0, 0.6, 0.8, 1.2);
    fill.position.set(0, 9, 2);
    fill.target.position.set(0, 0, -depth / 2);
    group.add(fill, fill.target);
  } else {
    group.add(new THREE.HemisphereLight(0xdcefff, 0x55703f, 1.3));
    const sun = new THREE.DirectionalLight(0xfff2d6, 2.8);
    sun.position.set(-8, 16, 9);
    sun.target.position.set(0, 0, -depth / 2);
    group.add(sun, sun.target);
    configureShadow(sun, depth + 4);
  }
}

function configureShadow(light: THREE.DirectionalLight, size: number) {
  light.castShadow = true;
  light.shadow.mapSize.set(2048, 2048);
  const camera = light.shadow.camera as THREE.OrthographicCamera;
  camera.left = camera.bottom = -size - 2;
  camera.right = camera.top = size + 2;
  camera.near = 1;
  camera.far = 40;
  light.shadow.bias = -0.0005;
}

/** An arc-shaped riser: from radius `inner` to `outer`, ±85° around the back of the stage. */
function riser(inner: number, outer: number, height: number): THREE.BufferGeometry {
  const shape = new THREE.Shape();
  const from = 5 * DEG;
  const to = 175 * DEG;
  shape.absarc(0, 0, outer, from, to, false);
  shape.absarc(0, 0, inner, to, from, true);
  const geometry = new THREE.ExtrudeGeometry(shape, { depth: height, bevelEnabled: false, curveSegments: 48 });
  // The shape's y axis becomes -z (behind the conductor), its depth becomes height.
  geometry.rotateX(-Math.PI / 2);
  return geometry;
}

function buildHall(group: THREE.Group, rows: number, owned: THREE.BufferGeometry[]) {
  const outer = FIRST_ROW + (rows - 1) * ROW_GAP + 1.1;
  const wood = standard(0x6f4a2e, { roughness: 0.6 });
  const darkWood = standard(0x4e331f, { roughness: 0.65 });
  const back = -(outer + 2.2);
  // The stage, 0.9 m above the hall floor, with its front edge.
  const front = 2.2;
  group.add(box(26, 0.9, front - back, wood, 0, -0.45, (front + back) / 2, owned));
  group.add(box(26, 0.92, 0.12, darkWood, 0, -0.45, front + 0.06, owned));
  // Risers for the rows behind the first.
  for (let k = 1; k < rows; k++) {
    const geometry = riser(FIRST_ROW + (k - 0.5) * ROW_GAP, outer, RISER_STEP);
    owned.push(geometry);
    const mesh = new THREE.Mesh(geometry, k % 2 ? darkWood : wood);
    mesh.position.y = (k - 1) * RISER_STEP;
    mesh.castShadow = mesh.receiveShadow = true;
    group.add(mesh);
  }
  // The acoustic shell around the back of the stage.
  const shellGeometry = new THREE.CylinderGeometry(outer + 1.4, outer + 1.4, 5, 64, 1, true, 80 * DEG, 200 * DEG);
  owned.push(shellGeometry);
  const shell = new THREE.Mesh(shellGeometry, standard(0x8a5e3a, { roughness: 0.7, side: THREE.DoubleSide }));
  shell.position.set(0, 2.5, 0);
  shell.receiveShadow = true;
  group.add(shell);
  // The hall: floor, walls, ceiling and a balcony at the back.
  const hallFloor = -0.9;
  group.add(box(34, 0.1, 30, standard(0x4a1d1f, { roughness: 0.95 }), 0, hallFloor - 0.05, front + 15, owned));
  const wall = standard(0x3b2a20, { roughness: 0.85 });
  group.add(box(0.4, 14, 32 - back, wall, -17, 6, (front + 30 + back) / 2, owned));
  group.add(box(0.4, 14, 32 - back, wall, 17, 6, (front + 30 + back) / 2, owned));
  group.add(box(34, 14, 0.4, wall, 0, 6, front + 30, owned));
  const ceiling = box(34, 0.4, 32 - back, standard(0x24180f, { roughness: 0.9 }), 0, 13, (front + 30 + back) / 2, owned);
  ceiling.userData.overhead = 12.8;
  group.add(ceiling);
  const balcony = standard(0x5c2c22, { roughness: 0.8 });
  group.add(box(34, 0.5, 6, balcony, 0, 4.4, front + 25, owned));
  group.add(box(34, 1.0, 0.25, standard(0xc9a46a, { roughness: 0.5, metalness: 0.3 }), 0, 5.15, front + 22.1, owned));
  // The audience: rows of red seats rising towards the back.
  const seat = mergeGeometries([new THREE.BoxGeometry(0.5, 0.08, 0.45).translate(0, 0.42, 0), new THREE.BoxGeometry(0.5, 0.5, 0.08).translate(0, 0.7, -0.2)]);
  if (seat) {
    owned.push(seat);
    const positions: THREE.Vector3[] = [];
    for (let row = 0; row < 16; row++) {
      for (let col = -13; col <= 13; col++) {
        if (col === 0) continue; // the aisle
        positions.push(new THREE.Vector3(col * 0.62, hallFloor + row * 0.14, front + 3 + row * 1.05));
      }
    }
    const seats = new THREE.InstancedMesh(seat, standard(0x8c1f2c, { roughness: 0.9 }), positions.length);
    const matrix = new THREE.Matrix4();
    positions.forEach((p, i) => seats.setMatrixAt(i, matrix.makeTranslation(p.x, p.y, p.z)));
    seats.receiveShadow = true;
    group.add(seats);
    // Each raised row stands on a step.
    for (let row = 1; row < 16; row++) {
      group.add(box(17, row * 0.14, 1.05, standard(0x3f1a1c, { roughness: 0.95 }), 0, hallFloor + (row * 0.14) / 2, front + 3 + row * 1.05, owned));
    }
  }
}

function buildBandstand(group: THREE.Group, rows: number, owned: THREE.BufferGeometry[]) {
  const center = bandstandCenter(rows);
  const radius = bandstandRadius(rows);
  const add = (geometry: THREE.BufferGeometry, mat: THREE.Material, x: number, y: number, z: number, rotationY = 0, shadows = true) => {
    owned.push(geometry);
    const mesh = new THREE.Mesh(geometry, mat);
    mesh.position.set(x, y, z);
    mesh.rotation.y = rotationY;
    mesh.castShadow = mesh.receiveShadow = shadows;
    group.add(mesh);
    return mesh;
  };
  // Grass, and a gravel path around the bandstand.
  const ground = add(new THREE.CircleGeometry(90, 64), standard(0x6f9a52, { roughness: 1 }), 0, 0, 0, 0);
  ground.rotation.x = -Math.PI / 2;
  ground.castShadow = false;
  const path = add(new THREE.RingGeometry(radius + 0.6, radius + 2.6, 48), standard(0xcdbf9f, { roughness: 1 }), center.x, 0.01, center.z, 0);
  path.rotation.x = -Math.PI / 2;
  path.castShadow = false;
  // The octagonal platform, its wooden floor and the steps up at the front.
  const turn = Math.PI / 8;
  add(new THREE.CylinderGeometry(radius, radius, BANDSTAND_HEIGHT, 8), standard(0xe8e1cc, { roughness: 0.7 }), center.x, BANDSTAND_HEIGHT / 2, center.z, turn);
  add(new THREE.CylinderGeometry(radius - 0.06, radius - 0.06, 0.04, 8), standard(0xa77b4f, { roughness: 0.55 }), center.x, BANDSTAND_HEIGHT + 0.0, center.z, turn);
  const frontEdge = center.z + radius * Math.cos(turn);
  for (let s = 0; s < 3; s++) {
    add(new THREE.BoxGeometry(2.4, BANDSTAND_HEIGHT * ((3 - s) / 3), 0.42), standard(0xd9d1bb, { roughness: 0.8 }), 0, (BANDSTAND_HEIGHT * ((3 - s) / 3)) / 2, frontEdge + 0.21 + s * 0.42);
  }
  // Cast-iron pillars and railings, open at the front.
  const iron = standard(0x2f5d50, { roughness: 0.5, metalness: 0.4 });
  const corners: THREE.Vector3[] = [];
  for (let i = 0; i < 8; i++) {
    const angle = turn + (i * Math.PI) / 4;
    const x = center.x + Math.sin(angle) * (radius - 0.2);
    const z = center.z + Math.cos(angle) * (radius - 0.2);
    corners.push(new THREE.Vector3(x, 0, z));
    add(new THREE.CylinderGeometry(0.07, 0.09, 3.1, 10), iron, x, BANDSTAND_HEIGHT + 1.55, z);
  }
  for (let i = 0; i < 8; i++) {
    const a = corners[i]!;
    const b = corners[(i + 1) % 8]!;
    const mid = a.clone().add(b).multiplyScalar(0.5);
    // The side facing the audience (+z) stays open.
    if (mid.z > center.z + radius * 0.8) continue;
    for (const height of [0.55, 0.95]) {
      const rail = add(new THREE.CylinderGeometry(0.025, 0.025, a.distanceTo(b), 6), iron, mid.x, BANDSTAND_HEIGHT + height, mid.z);
      rail.rotation.set(0, 0, 0);
      rail.lookAt(b.x, BANDSTAND_HEIGHT + height, b.z);
      rail.rotateX(Math.PI / 2);
    }
  }
  // The roof: a red octagonal cone with a white eave and a finial.
  const roofY = BANDSTAND_HEIGHT + 3.1;
  for (const mesh of [
    add(new THREE.CylinderGeometry(radius + 0.45, radius + 0.45, 0.3, 8, 1, true), standard(0xf3efe3, { roughness: 0.6, side: THREE.DoubleSide }), center.x, roofY + 0.15, center.z, turn),
    add(new THREE.ConeGeometry(radius + 0.55, 2.2, 8), standard(0x8e2f2f, { roughness: 0.7 }), center.x, roofY + 0.3 + 1.1, center.z, turn),
    add(new THREE.SphereGeometry(0.18, 12, 8), standard(0xd9a93a, { metalness: 0.6, roughness: 0.3 }), center.x, roofY + 2.55, center.z),
  ]) {
    mesh.userData.overhead = roofY;
  }
  // Trees around the park, and benches for the audience.
  const trunk = standard(0x6b4a2f, { roughness: 0.9 });
  const leaves = [standard(0x3f7a3a, { roughness: 0.9 }), standard(0x4f8f45, { roughness: 0.9 }), standard(0x356b33, { roughness: 0.9 })];
  const trees = [
    [-16, -14],
    [-22, -2],
    [-12, -26],
    [6, -24],
    [18, -16],
    [24, -3],
    [-26, 12],
    [27, 14],
    [-8, 24],
    [14, 26],
  ];
  trees.forEach(([x, z], i) => {
    const height = 3 + (i % 3);
    add(new THREE.CylinderGeometry(0.22, 0.32, height, 8), trunk, x!, height / 2, z!);
    add(new THREE.SphereGeometry(2.2 + (i % 2), 14, 10), leaves[i % 3]!, x!, height + 1.6, z!);
    add(new THREE.SphereGeometry(1.6, 12, 8), leaves[(i + 1) % 3]!, x! + 1.2, height + 0.8, z! + 0.6);
  });
  const benchWood = standard(0x8a5a2b, { roughness: 0.7 });
  for (const [x, z] of [
    [-4.5, 7],
    [0, 7.5],
    [4.5, 7],
    [-5, 10.5],
    [0, 11],
    [5, 10.5],
  ]) {
    add(new THREE.BoxGeometry(2, 0.07, 0.45), benchWood, x!, 0.45, z!);
    add(new THREE.BoxGeometry(2, 0.35, 0.06), benchWood, x!, 0.72, z! + 0.22);
    add(new THREE.BoxGeometry(0.08, 0.45, 0.45), iron, x! - 0.9, 0.225, z!);
    add(new THREE.BoxGeometry(0.08, 0.45, 0.45), iron, x! + 0.9, 0.225, z!);
  }
}

register<VenueComponent>("mc-venue", {
  schema: { type: { type: "string", default: "hall" }, rows: { type: "int", default: 1 } },
  init() {
    this.group = null;
    this.owned = [];
    this.overhead = [];
  },
  update() {
    if (this.group) this.el.removeObject3D("mesh");
    for (const geometry of this.owned) geometry.dispose();
    this.owned = [];
    const group = new THREE.Group();
    const rows = Math.max(1, this.data.rows);
    const kind = this.data.type === "bandstand" ? "bandstand" : "hall";
    if (kind === "hall") buildHall(group, rows, this.owned);
    else buildBandstand(group, rows, this.owned);
    lights(group, kind, rows);
    this.group = group;
    this.overhead = [];
    group.traverse((object) => {
      if (typeof object.userData.overhead === "number") this.overhead.push({ object, below: object.userData.overhead as number });
    });
    this.el.setObject3D("mesh", group);
    const scene = this.el.sceneEl;
    if (scene) {
      const object = scene.object3D as THREE.Scene;
      object.background = new THREE.Color(kind === "hall" ? 0x17110c : 0x9cc4e8);
      object.fog = kind === "hall" ? null : new THREE.Fog(0xb6d3ee, 35, 95);
    }
  },
  tick() {
    const camera = this.el.sceneEl?.camera;
    if (!camera || !this.overhead.length) return;
    const y = new THREE.Vector3().setFromMatrixPosition(camera.matrixWorld).y;
    for (const { object, below } of this.overhead) object.visible = y < below;
  },
  remove() {
    this.el.removeObject3D("mesh");
    for (const geometry of this.owned) geometry.dispose();
  },
});

// ---------------------------------------------------------------------------------------------
// The camera: flying to viewpoints, and carrying the listener for spatial sound

interface LookControls {
  yawObject: THREE.Object3D;
  pitchObject: THREE.Object3D;
}

interface CameraComponent extends Component<Record<string, never>> {
  flight: { from: THREE.Vector3; to: THREE.Vector3; yawFrom: number; yawTo: number; pitchFrom: number; pitchTo: number; start: number; duration: number } | null;
  lastPosition: THREE.Vector3;
  lastForward: THREE.Vector3;
  flyTo(position: { x: number; y: number; z: number }, target: { x: number; y: number; z: number }, duration?: number): void;
}

function look(el: Entity): LookControls | null {
  const controls = el.components["look-controls"] as Partial<LookControls> | undefined;
  return controls?.yawObject && controls.pitchObject ? (controls as LookControls) : null;
}

register<CameraComponent>("mc-camera", {
  init() {
    this.flight = null;
    this.lastPosition = new THREE.Vector3(1e9, 0, 0);
    this.lastForward = new THREE.Vector3();
    this.flyTo = (position, target, duration = 900) => {
      const controls = look(this.el);
      const from = this.el.object3D.position.clone();
      const to = new THREE.Vector3(position.x, position.y, position.z);
      const d = new THREE.Vector3(target.x - to.x, target.y - to.y, target.z - to.z);
      const yawTo = Math.atan2(-d.x, -d.z);
      const pitchTo = Math.atan2(d.y, Math.hypot(d.x, d.z));
      const yawFrom = controls?.yawObject.rotation.y ?? 0;
      // Turn the short way round.
      const yawEnd = yawFrom + Math.atan2(Math.sin(yawTo - yawFrom), Math.cos(yawTo - yawFrom));
      this.flight = { from, to, yawFrom, yawTo: yawEnd, pitchFrom: controls?.pitchObject.rotation.x ?? 0, pitchTo, start: performance.now(), duration };
    };
  },
  tick() {
    const flight = this.flight;
    if (flight) {
      const t = Math.min(1, (performance.now() - flight.start) / flight.duration);
      const ease = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
      this.el.object3D.position.lerpVectors(flight.from, flight.to, ease);
      const controls = look(this.el);
      if (controls) {
        controls.yawObject.rotation.y = flight.yawFrom + (flight.yawTo - flight.yawFrom) * ease;
        controls.pitchObject.rotation.x = flight.pitchFrom + (flight.pitchTo - flight.pitchFrom) * ease;
      }
      if (t >= 1) this.flight = null;
    }
    if (!stageState.spatial) return;
    // The listener's ears follow the camera.
    const camera = this.el.object3D;
    camera.updateMatrixWorld();
    const position = new THREE.Vector3().setFromMatrixPosition(camera.matrixWorld);
    const forward = new THREE.Vector3(0, 0, -1).transformDirection(camera.matrixWorld);
    if (position.distanceTo(this.lastPosition) > 0.03 || forward.angleTo(this.lastForward) > 0.02) {
      this.lastPosition.copy(position);
      this.lastForward.copy(forward);
      usePlayback.getState().setListener({ x: position.x, y: position.y, z: position.z }, { x: forward.x, y: forward.y, z: forward.z });
    }
  },
});
