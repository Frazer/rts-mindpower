/** Seeded PRNG (mulberry32). The sim uses only this, never Math.random, so games are replayable. */
export class Rng {
  private s: number;

  constructor(seed: number) {
    this.s = seed >>> 0 || 1;
  }

  /** Current position in the sequence, for saving and restoring a game. */
  get state(): number {
    return this.s;
  }

  set state(v: number) {
    this.s = v >>> 0;
  }

  next(): number {
    let t = (this.s = (this.s + 0x6d2b79f5) >>> 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  range(a: number, b: number): number {
    return a + (b - a) * this.next();
  }

  /** Inclusive integer range. */
  int(a: number, b: number): number {
    return Math.floor(this.range(a, b + 1));
  }

  chance(p: number): boolean {
    return this.next() < p;
  }

  pick<T>(arr: readonly T[]): T {
    return arr[Math.floor(this.next() * arr.length)];
  }

  /** Approximately standard-normal (sum of three uniforms). */
  gauss(): number {
    return (this.next() + this.next() + this.next() - 1.5) / 0.5;
  }
}
