import { DT } from '../sim/config';
import type { World } from '../sim/world';
import { HASH_EVERY, TURN_SEC, type Turn } from './protocol';

export interface LockstepOut {
  /** A fingerprint of the game after turn `n`. */
  hash(n: number, h: number): void;
  /** The whole game after turn `n`, for a player who fell out of step. */
  snap(n: number, data: string): void;
}

/**
 * Plays the server's turns in order. Each turn's orders go in, then its ticks run;
 * between turns every player's game is in exactly the same state.
 */
export class Lockstep {
  private readonly queue = new Map<number, Turn>();
  /** Next turn to start. */
  private next = 1;
  private cur: { turn: Turn; left: number } | null = null;
  private snapWanted = false;
  /** Rejoining: wait for a copy of the game before playing anything. */
  private waiting: boolean;

  constructor(
    private readonly world: World,
    private readonly out: LockstepOut,
    resume = false,
  ) {
    this.waiting = resume;
  }

  add(t: Turn): void {
    if (t.n >= this.next && t.k >= 1) this.queue.set(t.n, t);
  }

  /** Turns received but not finished yet. */
  get backlog(): number {
    return this.queue.size + (this.cur ? 1 : 0);
  }

  /** Last turn fully played. */
  get done(): number {
    return this.next - 1 - (this.cur ? 1 : 0);
  }

  /** Real seconds each tick of the current turn stands for. */
  tickCost(): number {
    const t = this.cur?.turn ?? this.queue.get(this.next);
    return TURN_SEC / (t?.k ?? Math.round(TURN_SEC / DT));
  }

  /** The host was asked for a copy of the game: send it at the next turn boundary. */
  requestSnap(): void {
    if (this.waiting) return;
    if (this.cur) this.snapWanted = true;
    else this.out.snap(this.next - 1, this.world.save());
  }

  /** Replace the game with the host's copy from after turn `n`, then queue the turns since. */
  load(n: number, data: string, turns: readonly Turn[]): void {
    if (data) this.world.load(data);
    this.next = n + 1;
    this.cur = null;
    this.snapWanted = false;
    this.waiting = false;
    for (const k of [...this.queue.keys()]) if (k <= n) this.queue.delete(k);
    for (const t of turns) this.add(t);
  }

  /** Run up to `max` ticks of whatever turns have arrived. Returns how many ran. */
  step(max: number): number {
    if (this.waiting) return 0;
    let ran = 0;
    while (ran < max) {
      if (!this.cur) {
        const t = this.queue.get(this.next);
        if (!t) break;
        this.queue.delete(this.next);
        this.next++;
        for (const c of t.c) this.world.command(c);
        this.cur = { turn: t, left: t.k };
      }
      this.world.tick(DT);
      ran++;
      if (--this.cur.left <= 0) {
        const n = this.cur.turn.n;
        this.cur = null;
        if (n % HASH_EVERY === 0) this.out.hash(n, this.world.hash());
        if (this.snapWanted) {
          this.snapWanted = false;
          this.out.snap(n, this.world.save());
        }
      }
    }
    return ran;
  }
}
