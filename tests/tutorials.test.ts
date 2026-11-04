import { describe, expect, it } from 'vitest';
import { MODES, type ModeId } from '../src/modes';
import { ADULT_AGE, DT, NEUTRAL, PLAYER } from '../src/sim/config';
import type { Blob, BuildingKind } from '../src/sim/types';
import { World } from '../src/sim/world';
import { TutorialRun, levelsFor } from '../src/tutorials';

/** What a player would do in each level, as sim commands and UI flags. */
type Solver = (p: Play) => void;

interface Play {
  w: World;
  run: TutorialRun;
  /** Your selected blobs (the solver sets this, like clicking would). */
  sel: Blob[];
  /** True once per step the first time the solver sees it. */
  fresh: boolean;
}

const own = (w: World): Blob[] => w.blobs.filter((b) => w.commandable(b, PLAYER) && b.age >= ADULT_AGE);
const strangers = (w: World): Blob[] => w.blobs.filter((b) => b.faction === NEUTRAL && b.alive);
const centre = (bs: Blob[]): [number, number] => [bs.reduce((s, b) => s + b.x, 0) / bs.length, bs.reduce((s, b) => s + b.y, 0) / bs.length];

function build(w: World, kind: BuildingKind, dx: number, dy: number): void {
  const hall = w.hall(PLAYER)!;
  for (let r = 0; r < 6; r++) {
    const x = hall.x + dx * (1 - r * 0.12);
    const y = hall.y + dy * (1 - r * 0.12) + r * 20;
    if (w.canPlace(PLAYER, kind, x, y).ok) {
      w.command({ type: 'build', faction: PLAYER, kind, x, y });
      return;
    }
  }
  throw new Error(`nowhere to put ${kind}`);
}

const befriendCrowd = (p: Play): void => {
  const s = strangers(p.w);
  if (!s.length || !p.sel.length) return;
  const [x, y] = centre(s);
  p.w.command({ type: 'befriendArea', faction: PLAYER, ids: p.sel.map((b) => b.id), x, y, r: 150, target: s[0].id });
};

const SOLVERS: Record<string, Solver> = {
  hello(p) {
    if (!p.fresh) return;
    if (p.run.step === 0) p.sel = [own(p.w)[0]];
    if (p.run.step === 1) p.w.command({ type: 'befriendArea', faction: PLAYER, ids: [p.sel[0].id], x: 0, y: 0, r: 150, target: p.run.mem.stranger });
  },
  controls(p) {
    if (!p.fresh) return;
    const did = p.run.did;
    if (p.run.step === 0) {
      p.sel = own(p.w).slice(0, 4);
      did.add('box');
    } else if (p.run.step === 1) did.add('groupSave');
    else if (p.run.step === 2) did.add('groupRecall');
    else {
      did.add('rightClick');
      befriendCrowd(p);
    }
  },
  crowd(p) {
    if (p.run.step === 0 && p.fresh) p.sel = own(p.w);
    // Like a player: send whoever is idle at whatever strangers are left.
    if (p.run.step >= 1 && p.w.time % 6 < DT) {
      p.sel = own(p.w).filter((b) => b.order.kind === 'none' && !b.area);
      befriendCrowd(p);
    }
  },
  homes(p) {
    if (p.fresh && p.run.step === 0) build(p.w, 'house', 150, -20);
  },
  school(p) {
    if (!p.fresh) return;
    if (p.run.step === 0) build(p.w, 'school', 0, 130);
    if (p.run.step === 1) {
      const s = p.w.buildings.find((b) => b.kind === 'school')!;
      p.w.command({ type: 'focus', faction: PLAYER, building: s.id, trait: 'kindness' });
    }
  },
  teach(p) {
    if (!p.fresh) return;
    const { mem, did } = p.run;
    if (p.run.step === 0) did.add('team');
    if (p.run.step === 1) p.sel = [p.w.byId.get(mem.prof)!];
    if (p.run.step === 2) p.w.command({ type: 'order', faction: PLAYER, ids: [mem.prof], order: 'teach', target: mem.grump });
    if (p.run.step === 3) p.w.command({ type: 'job', faction: PLAYER, ids: [mem.prof], job: 'teacher' });
  },
  fountain(p) {
    if (p.fresh && p.run.step === 0) build(p.w, 'fountain', 175, 0);
  },
  takeover(p) {
    if (!p.fresh) return;
    if (p.run.step === 0) p.sel = own(p.w).slice(0, 5);
    if (p.run.step === 1) p.w.command({ type: 'order', faction: PLAYER, ids: p.sel.map((b) => b.id), order: 'usurp', building: p.run.mem.market });
  },
  police(p) {
    if (p.fresh && p.run.step === 0) build(p.w, 'police', -150, 0);
  },
  island(p) {
    const w = p.w;
    if (p.fresh) build(w, 'house', 150, -40);
    // Every adult recruits; a few go and take over the pink town hall.
    if (w.time % 5 < DT) {
      const idle = own(w).filter((b) => b.job === 'social' && b.order.kind === 'none');
      if (idle.length) w.command({ type: 'job', faction: PLAYER, ids: idle.map((b) => b.id), job: 'recruiter' });
    }
    const pink = w.buildings.find((b) => b.faction === 2 && b.kind === 'hall');
    if (pink && w.time > 60 && w.time % 20 < DT) {
      const team = own(w).slice(0, 6);
      w.command({ type: 'order', faction: PLAYER, ids: team.map((b) => b.id), order: 'usurp', building: pink.id });
    }
  },
};

function play(mode: ModeId, id: string, seed: number, limit: number): { done: boolean; time: number; step: number } {
  const level = levelsFor(mode).find((l) => l.id === id)!;
  const run = new TutorialRun(level);
  const w = new World(MODES[mode], seed, run.worldOptions());
  const p: Play = { w, run, sel: [], fresh: true };
  let seen = -1;
  for (let i = 0; i < limit / DT && !run.done; i++) {
    p.fresh = run.step !== seen;
    seen = run.step;
    SOLVERS[id](p);
    w.tick(DT);
    p.sel = p.sel.filter((b) => w.commandable(b, PLAYER));
    run.update(w, p.sel, w.drainEvents());
  }
  return { done: run.done, time: Math.round(w.time), step: run.step };
}

describe('tutorial levels', () => {
  for (const mode of ['casual', 'pro'] as const) {
    it(`${mode}: every level can be finished`, () => {
      const rows: Record<string, string> = {};
      const failed: string[] = [];
      for (const level of levelsFor(mode)) {
        expect(SOLVERS[level.id], `no solver for ${level.id}`).toBeDefined();
        const limit = level.id === 'island' ? 1200 : 300;
        const times: number[] = [];
        for (const seed of [1, 2, 3]) {
          const r = play(mode, level.id, seed, limit);
          times.push(r.done ? r.time : -1);
          if (!r.done) failed.push(`${level.id} seed ${seed} stuck on step ${r.step + 1}`);
        }
        rows[level.id] = times.map((t) => (t < 0 ? 'STUCK' : `${t}s`)).join(' / ');
      }
      console.log(`\n[${mode}] seconds to finish (seeds 1/2/3)`);
      console.table(rows);
      expect(failed).toEqual([]);
    });
  }

  it('each mode gets its own list, Pro has the controls level', () => {
    expect(levelsFor('casual').some((l) => l.id === 'controls')).toBe(false);
    expect(levelsFor('pro')[1].id).toBe('controls');
    expect(new Set(levelsFor('pro').map((l) => l.id)).size).toBe(levelsFor('pro').length);
  });
});

describe('tutorial progress', () => {
  it('remembers finished levels per mode, even without storage', async () => {
    const { completed, markCompleted, resetProgress } = await import('../src/progress');
    resetProgress('casual');
    markCompleted('casual', 'hello');
    markCompleted('casual', 'hello');
    expect([...completed('casual')]).toEqual(['hello']);
    expect(completed('pro').has('hello')).toBe(false);
    resetProgress('casual');
    expect(completed('casual').size).toBe(0);
  });
});
