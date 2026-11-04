import { platform } from './platform';

/**
 * Little sound effects made on the fly with Web Audio (no audio files to download),
 * plus the mute switch. Nothing here touches the simulation.
 */

export type SoundName =
  | 'tap'
  | 'select'
  | 'go'
  | 'befriend'
  | 'lost'
  | 'birth'
  | 'build'
  | 'bonk'
  | 'arrest'
  | 'takeover'
  | 'lostBuilding'
  | 'tech'
  | 'step'
  | 'win'
  | 'lose'
  | 'error'
  | 'coin';

const MUTE_KEY = 'mindblobs.muted';
const VOLUME = 0.5;

/** Shortest gap (seconds) between two plays of one sound, so busy moments don't turn into noise. */
const GAP: Partial<Record<SoundName, number>> = {
  tap: 0.04,
  select: 0.05,
  go: 0.08,
  befriend: 0.12,
  lost: 0.3,
  birth: 0.25,
  build: 0.2,
  bonk: 0.18,
  arrest: 1.5,
  error: 0.3,
};

// Note frequencies (Hz).
const C4 = 261.63, E4 = 329.63, G4 = 392, C5 = 523.25, E5 = 659.25, G5 = 783.99, B5 = 987.77;
const C6 = 1046.5, E6 = 1318.5, G6 = 1568, B6 = 1975.5, C7 = 2093;

type Voice = {
  tone(type: OscillatorType, f0: number, f1: number, at: number, dur: number, vol: number): void;
  hiss(at: number, dur: number, vol: number, freq: number): void;
};

const RECIPES: Record<SoundName, (v: Voice) => void> = {
  tap: (v) => v.tone('sine', 900, 700, 0, 0.05, 0.07),
  select: (v) => v.tone('triangle', 660, 880, 0, 0.07, 0.1),
  go: (v) => v.tone('sine', 440, 640, 0, 0.09, 0.1),
  befriend: (v) => {
    v.tone('sine', C6, C6, 0, 0.18, 0.13);
    v.tone('sine', E6, E6, 0.07, 0.28, 0.11);
    v.tone('triangle', C5, C5, 0, 0.25, 0.05);
  },
  lost: (v) => {
    v.tone('triangle', 520, 500, 0, 0.16, 0.1);
    v.tone('triangle', 390, 370, 0.11, 0.26, 0.1);
  },
  birth: (v) => {
    v.tone('sine', 280, 900, 0, 0.12, 0.15);
    v.tone('sine', 1200, 1260, 0.09, 0.08, 0.05);
  },
  build: (v) => {
    v.tone('sine', 150, 70, 0, 0.18, 0.25);
    v.hiss(0, 0.08, 0.12, 900);
    v.tone('triangle', G5, G5, 0.1, 0.3, 0.07);
  },
  bonk: (v) => {
    v.hiss(0, 0.1, 0.2, 600);
    v.tone('sine', 180, 60, 0, 0.14, 0.22);
  },
  arrest: (v) => {
    for (let i = 0; i < 4; i++) v.tone('square', i % 2 ? 740 : 880, i % 2 ? 740 : 880, i * 0.16, 0.15, 0.03);
  },
  takeover: (v) => {
    [C5, E5, G5, C6].forEach((f, i) => v.tone('triangle', f, f, i * 0.07, i === 3 ? 0.45 : 0.12, 0.11));
  },
  lostBuilding: (v) => {
    [G5, 622.25, C5].forEach((f, i) => v.tone('triangle', f, f, i * 0.11, i === 2 ? 0.4 : 0.14, 0.1));
  },
  tech: (v) => {
    [E6, G6, C7].forEach((f, i) => v.tone('sine', f, f, i * 0.05, 0.22, 0.05));
  },
  step: (v) => {
    v.tone('sine', E6, E6, 0, 0.35, 0.11);
    v.tone('sine', B6, B6, 0.06, 0.3, 0.05);
  },
  win: (v) => {
    [C5, E5, G5, C6, E6].forEach((f, i) => {
      v.tone('triangle', f, f, i * 0.1, i === 4 ? 0.7 : 0.16, 0.11);
      v.tone('sine', f * 2, f * 2, i * 0.1, i === 4 ? 0.6 : 0.12, 0.03);
    });
  },
  lose: (v) => {
    [G4, E4, C4].forEach((f, i) => v.tone('triangle', f, f * (i === 2 ? 0.97 : 1), i * 0.22, i === 2 ? 0.8 : 0.24, 0.12));
  },
  error: (v) => v.tone('square', 180, 150, 0, 0.12, 0.035),
  coin: (v) => {
    v.tone('square', B5, B5, 0, 0.07, 0.04);
    v.tone('square', E6, E6, 0.07, 0.3, 0.04);
  },
};

class SoundBoard {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private noise: AudioBuffer | null = null;
  private muted: boolean | null = null;
  /** Silenced for a reason other than the player's choice (an ad playing, the tab hidden). */
  private readonly holds = new Set<string>();
  private readonly last = new Map<SoundName, number>();
  private readonly listeners = new Set<(muted: boolean) => void>();

  get isMuted(): boolean {
    if (this.muted === null) this.muted = platform.storage.getItem(MUTE_KEY) === '1';
    return this.muted;
  }

  /**
   * Browsers only start audio after a tap or key press, and iOS can suspend it again
   * (calls, other apps), so call this from every gesture. It's cheap once running.
   */
  unlock(): void {
    if (!this.ctx) {
      const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctx) return;
      try {
        this.ctx = new Ctx();
      } catch {
        return; // No audio on this device; the game works silently.
      }
      this.master = this.ctx.createGain();
      this.master.gain.value = this.audible() ? VOLUME : 0;
      this.master.connect(this.ctx.destination);
    }
    if (this.ctx.state !== 'running' && this.audible()) void this.ctx.resume().catch(() => {});
  }

  setMuted(m: boolean): void {
    this.muted = m;
    platform.storage.setItem(MUTE_KEY, m ? '1' : '0');
    this.apply();
    for (const fn of this.listeners) fn(m);
  }

  toggle(): void {
    this.setMuted(!this.isMuted);
  }

  /** Get told when the mute switch changes. Returns a function that stops listening. */
  onChange(fn: (muted: boolean) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Silence everything while `reason` holds (ads, hidden tab), without touching the player's setting. */
  hold(reason: string, on: boolean): void {
    if (on) this.holds.add(reason);
    else this.holds.delete(reason);
    this.apply();
  }

  play(name: SoundName): void {
    const c = this.ctx;
    if (!c || !this.master || c.state !== 'running' || !this.audible()) return;
    const now = c.currentTime;
    if (now - (this.last.get(name) ?? -Infinity) < (GAP[name] ?? 0)) return;
    this.last.set(name, now);
    RECIPES[name](this.voice(c, this.master, now));
  }

  private audible(): boolean {
    return !this.isMuted && this.holds.size === 0;
  }

  private apply(): void {
    const c = this.ctx;
    if (!c || !this.master) return;
    const on = this.audible();
    this.master.gain.setTargetAtTime(on ? VOLUME : 0, c.currentTime, 0.02);
    if (on && c.state === 'suspended') void c.resume().catch(() => {});
    if (!on && c.state === 'running') void c.suspend().catch(() => {});
  }

  private voice(c: AudioContext, out: AudioNode, t0: number): Voice {
    return {
      tone: (type, f0, f1, at, dur, vol) => {
        const t = t0 + at;
        const o = c.createOscillator();
        const g = c.createGain();
        o.type = type;
        o.frequency.setValueAtTime(f0, t);
        if (f1 !== f0) o.frequency.exponentialRampToValueAtTime(f1, t + dur);
        g.gain.setValueAtTime(0.0001, t);
        g.gain.exponentialRampToValueAtTime(vol, t + 0.005);
        g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
        o.connect(g).connect(out);
        o.start(t);
        o.stop(t + dur + 0.02);
      },
      hiss: (at, dur, vol, freq) => {
        const t = t0 + at;
        const src = c.createBufferSource();
        src.buffer = this.noiseBuffer(c);
        const f = c.createBiquadFilter();
        f.type = 'lowpass';
        f.frequency.value = freq;
        const g = c.createGain();
        g.gain.setValueAtTime(vol, t);
        g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
        src.connect(f).connect(g).connect(out);
        src.start(t);
        src.stop(t + dur + 0.02);
      },
    };
  }

  private noiseBuffer(c: AudioContext): AudioBuffer {
    if (!this.noise) {
      this.noise = c.createBuffer(1, Math.floor(c.sampleRate * 0.5), c.sampleRate);
      const d = this.noise.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    }
    return this.noise;
  }
}

export const sound = new SoundBoard();
