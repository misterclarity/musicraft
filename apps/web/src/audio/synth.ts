import type { InstrumentFamily } from "@musicraft/score-core";

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/**
 * How parts are placed in space: "stereo" spreads them left to right from their seats, as heard
 * from the conductor; "room" places them in 3D around a listener that can move (the stage view).
 */
export type SpaceMode = "stereo" | "room";
/** The acoustics: none, a concert hall's reverberation, or an open-air bandstand's short echo. */
export type Room = "dry" | "hall" | "bandstand";

/** One part's way to the speakers: volume, position, and a send to the room's reverberation. */
interface Channel {
  input: GainNode;
  panner: PannerNode;
  send: GainNode;
}

/**
 * A small WebAudio synthesizer with a recognisable sound per instrument family. Good enough to
 * proofread and audition arrangements without downloading sample libraries.
 */
export class Synth {
  readonly context: AudioContext;
  private readonly output: GainNode;
  private readonly reverb: ConvolverNode;
  private readonly reverbReturn: GainNode;
  private active = new Set<AudioScheduledSourceNode>();
  private channels = new Map<string, Channel>();
  private mode: SpaceMode = "stereo";
  private room: Room = "dry";

  constructor() {
    this.context = new AudioContext({ latencyHint: "interactive" });
    const compressor = this.context.createDynamicsCompressor();
    compressor.threshold.value = -14;
    compressor.ratio.value = 4;
    this.output = this.context.createGain();
    this.output.gain.value = 0.8;
    this.output.connect(compressor).connect(this.context.destination);
    this.reverb = this.context.createConvolver();
    this.reverbReturn = this.context.createGain();
    this.reverbReturn.gain.value = 0;
    this.reverb.connect(this.reverbReturn).connect(this.output);
    this.setListener({ x: 0, y: 1.6, z: 1.5 }, { x: 0, y: 0, z: -1 });
  }

  setVolume(volume: number) {
    this.output.gain.setTargetAtTime(Math.max(0, Math.min(1, volume)), this.context.currentTime, 0.02);
  }

  /** A part's channel, created on first use. */
  private channel(id: string): Channel {
    let channel = this.channels.get(id);
    if (!channel) {
      const ctx = this.context;
      const input = ctx.createGain();
      const panner = ctx.createPanner();
      const send = ctx.createGain();
      input.connect(panner).connect(this.output);
      input.connect(send).connect(this.reverb);
      channel = { input, panner, send };
      this.configurePanner(panner);
      send.gain.value = this.room === "dry" ? 0 : 1;
      this.channels.set(id, channel);
    }
    return channel;
  }

  private configurePanner(panner: PannerNode) {
    // In a room, sound fades with distance and is heard through the head (HRTF); in stereo only
    // the direction counts, so every part stays as loud as before.
    panner.panningModel = this.mode === "room" ? "HRTF" : "equalpower";
    panner.distanceModel = "inverse";
    panner.refDistance = this.mode === "room" ? 2 : 1;
    // Gentler than nature, so the balcony is still worth listening from.
    panner.rolloffFactor = this.mode === "room" ? 0.5 : 0;
  }

  setSpace(mode: SpaceMode, room: Room) {
    this.mode = mode;
    for (const channel of this.channels.values()) this.configurePanner(channel.panner);
    if (room !== this.room) {
      this.room = room;
      if (room !== "dry") this.reverb.buffer = impulseResponse(this.context, room === "hall" ? 2.6 : 0.9, room === "hall" ? 2.2 : 4);
      const wet = room === "hall" ? 0.32 : room === "bandstand" ? 0.12 : 0;
      this.reverbReturn.gain.setTargetAtTime(wet, this.context.currentTime, 0.05);
      for (const channel of this.channels.values()) channel.send.gain.value = room === "dry" ? 0 : 1;
    }
  }

  /** Volume of a part (0 silences it at once, also notes already scheduled). */
  setChannelGain(id: string, gain: number) {
    this.channel(id).input.gain.setTargetAtTime(Math.max(0, gain), this.context.currentTime, 0.02);
  }

  /** Where a part sits, in metres (x to the audience's right, y up, z towards the audience). */
  setChannelPosition(id: string, position: Vec3) {
    const panner = this.channel(id).panner;
    setVec(panner, "position", position);
  }

  /** Where the listener is and which way they face. */
  setListener(position: Vec3, forward: Vec3, up: Vec3 = { x: 0, y: 1, z: 0 }) {
    const listener = this.context.listener;
    if (listener.positionX) {
      const t = this.context.currentTime;
      listener.positionX.setTargetAtTime(position.x, t, 0.03);
      listener.positionY.setTargetAtTime(position.y, t, 0.03);
      listener.positionZ.setTargetAtTime(position.z, t, 0.03);
      listener.forwardX.setTargetAtTime(forward.x, t, 0.03);
      listener.forwardY.setTargetAtTime(forward.y, t, 0.03);
      listener.forwardZ.setTargetAtTime(forward.z, t, 0.03);
      listener.upX.setTargetAtTime(up.x, t, 0.03);
      listener.upY.setTargetAtTime(up.y, t, 0.03);
      listener.upZ.setTargetAtTime(up.z, t, 0.03);
    } else {
      // Firefox has only the older methods.
      listener.setPosition(position.x, position.y, position.z);
      listener.setOrientation(forward.x, forward.y, forward.z, up.x, up.y, up.z);
    }
  }

  /** Schedule one note. `time` is in AudioContext seconds; `channelId` routes it through that part's channel. */
  note(time: number, duration: number, midi: number, velocity: number, family: InstrumentFamily, channelId?: string) {
    const ctx = this.context;
    const frequency = 440 * 2 ** ((midi - 69) / 12);
    const level = 0.22 * (velocity / 127) ** 1.4;
    const gain = ctx.createGain();
    gain.connect(channelId ? this.channel(channelId).input : this.output);
    const end = time + Math.max(0.03, duration);
    const sources: AudioScheduledSourceNode[] = [];
    const osc = (type: OscillatorType, freq: number, target: AudioNode, detune = 0) => {
      const o = ctx.createOscillator();
      o.type = type;
      o.frequency.value = freq;
      o.detune.value = detune;
      o.connect(target);
      sources.push(o);
      return o;
    };
    const vibrato = (depthCents: number, rate: number, onset: number) => {
      const lfo = ctx.createOscillator();
      const depth = ctx.createGain();
      lfo.frequency.value = rate;
      depth.gain.setValueAtTime(0, time);
      depth.gain.linearRampToValueAtTime(depthCents, time + onset);
      lfo.connect(depth);
      sources.push(lfo);
      return depth;
    };

    let release = 0.08;
    switch (family) {
      case "brass": {
        const filter = ctx.createBiquadFilter();
        filter.type = "lowpass";
        filter.Q.value = 1.2;
        const bright = frequency * (2.5 + 5 * (velocity / 127));
        filter.frequency.setValueAtTime(frequency * 1.2, time);
        filter.frequency.exponentialRampToValueAtTime(Math.min(12000, bright), time + 0.07);
        filter.connect(gain);
        const a = osc("sawtooth", frequency, filter);
        const b = osc("sawtooth", frequency, filter, 6);
        const vib = vibrato(8, 5.2, 0.35);
        vib.connect(a.detune);
        vib.connect(b.detune);
        envelope(gain.gain, time, end, level, 0.035, 0.12, 0.78);
        break;
      }
      case "woodwind": {
        const filter = ctx.createBiquadFilter();
        filter.type = "lowpass";
        filter.frequency.value = Math.min(9000, frequency * 6);
        filter.connect(gain);
        const a = osc("triangle", frequency, filter);
        const b = osc("square", frequency, filter);
        const mix = ctx.createGain();
        mix.gain.value = 0.18;
        b.disconnect();
        b.connect(mix).connect(filter);
        const vib = vibrato(10, 5, 0.4);
        vib.connect(a.detune);
        vib.connect(b.detune);
        envelope(gain.gain, time, end, level, 0.045, 0.1, 0.85);
        break;
      }
      case "strings": {
        const filter = ctx.createBiquadFilter();
        filter.type = "lowpass";
        filter.frequency.value = Math.min(8000, frequency * 5);
        filter.connect(gain);
        const a = osc("sawtooth", frequency, filter, -4);
        const b = osc("sawtooth", frequency, filter, 4);
        const vib = vibrato(14, 5.6, 0.3);
        vib.connect(a.detune);
        vib.connect(b.detune);
        envelope(gain.gain, time, end, level * 0.8, 0.09, 0.15, 0.85);
        release = 0.15;
        break;
      }
      case "keyboard": {
        osc("triangle", frequency, gain);
        const overtone = ctx.createGain();
        overtone.gain.value = 0.25;
        overtone.connect(gain);
        osc("sine", frequency * 2, overtone);
        // Struck string: fast attack, steady decay.
        const decay = Math.min(4, 0.6 + 120 / frequency);
        gain.gain.setValueAtTime(0, time);
        gain.gain.linearRampToValueAtTime(level * 1.2, time + 0.006);
        gain.gain.setTargetAtTime(level * 0.05, time + 0.01, decay / 3);
        gain.gain.setTargetAtTime(0, end, 0.08);
        release = 0.4;
        break;
      }
      case "voice": {
        const a = osc("sine", frequency, gain);
        const second = ctx.createGain();
        second.gain.value = 0.3;
        second.connect(gain);
        const b = osc("triangle", frequency, second);
        const vib = vibrato(22, 5.4, 0.25);
        vib.connect(a.detune);
        vib.connect(b.detune);
        envelope(gain.gain, time, end, level, 0.07, 0.1, 0.9);
        break;
      }
      default: {
        osc("triangle", frequency, gain);
        envelope(gain.gain, time, end, level, 0.02, 0.1, 0.8);
      }
    }
    for (const s of sources) {
      s.start(time);
      s.stop(end + release + 0.05);
      this.active.add(s);
      s.onended = () => {
        this.active.delete(s);
        s.disconnect();
      };
    }
  }

  /** Silence everything that is playing or scheduled. */
  stopAll() {
    const now = this.context.currentTime;
    for (const s of this.active) {
      try {
        s.stop(now + 0.01);
      } catch {
        // already stopped
      }
    }
    this.active.clear();
  }
}

function setVec(panner: PannerNode, what: "position", v: Vec3) {
  if (panner.positionX) {
    const t = panner.context.currentTime;
    panner.positionX.setTargetAtTime(v.x, t, 0.03);
    panner.positionY.setTargetAtTime(v.y, t, 0.03);
    panner.positionZ.setTargetAtTime(v.z, t, 0.03);
  } else if (what === "position") {
    panner.setPosition(v.x, v.y, v.z);
  }
}

/** A room's echo as decaying stereo noise: `seconds` long, fading faster with a larger `decay`. */
function impulseResponse(ctx: BaseAudioContext, seconds: number, decay: number): AudioBuffer {
  const length = Math.max(1, Math.floor(ctx.sampleRate * seconds));
  const buffer = ctx.createBuffer(2, length, ctx.sampleRate);
  for (let c = 0; c < 2; c++) {
    const data = buffer.getChannelData(c);
    for (let i = 0; i < length; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / length) ** decay;
  }
  return buffer;
}

function envelope(param: AudioParam, start: number, end: number, peak: number, attack: number, decay: number, sustain: number) {
  param.setValueAtTime(0, start);
  param.linearRampToValueAtTime(peak, start + attack);
  param.setTargetAtTime(peak * sustain, start + attack, decay / 3);
  param.setTargetAtTime(0, Math.max(end, start + attack), 0.05);
}
