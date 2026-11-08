import type { InstrumentFamily } from "@musicraft/score-core";

/**
 * A small WebAudio synthesizer with a recognisable sound per instrument family. Good enough to
 * proofread and audition arrangements without downloading sample libraries.
 */
export class Synth {
  readonly context: AudioContext;
  private readonly output: GainNode;
  private active = new Set<AudioScheduledSourceNode>();

  constructor() {
    this.context = new AudioContext({ latencyHint: "interactive" });
    const compressor = this.context.createDynamicsCompressor();
    compressor.threshold.value = -14;
    compressor.ratio.value = 4;
    this.output = this.context.createGain();
    this.output.gain.value = 0.8;
    this.output.connect(compressor).connect(this.context.destination);
  }

  setVolume(volume: number) {
    this.output.gain.setTargetAtTime(Math.max(0, Math.min(1, volume)), this.context.currentTime, 0.02);
  }

  /** Schedule one note. `time` is in AudioContext seconds. */
  note(time: number, duration: number, midi: number, velocity: number, family: InstrumentFamily) {
    const ctx = this.context;
    const frequency = 440 * 2 ** ((midi - 69) / 12);
    const level = 0.22 * (velocity / 127) ** 1.4;
    const gain = ctx.createGain();
    gain.connect(this.output);
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

function envelope(param: AudioParam, start: number, end: number, peak: number, attack: number, decay: number, sustain: number) {
  param.setValueAtTime(0, start);
  param.linearRampToValueAtTime(peak, start + attack);
  param.setTargetAtTime(peak * sustain, start + attack, decay / 3);
  param.setTargetAtTime(0, Math.max(end, start + attack), 0.05);
}
