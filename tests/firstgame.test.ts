import { describe, expect, it } from 'vitest';
import { Coach } from '../src/coach';
import { MODES, type ModeId } from '../src/modes';
import { ADULT_AGE, DT, NEUTRAL, PLAYER } from '../src/sim/config';
import { MAP_IDS, SIZE_IDS } from '../src/sim/maps';
import { World } from '../src/sim/world';
import { ALL_FEATURES, UNLOCKS, nextUnlock, unlock, unlocked } from '../src/unlocks';

const run = (w: World, seconds: number): void => {
  for (let i = 0; i < Math.round(seconds / DT) && !w.outcome; i++) {
    w.tick(DT);
    w.drainEvents();
  }
};

/** Rival blobs sent out to befriend someone. */
const sentOut = (w: World): number =>
  w.blobs.filter((b) => b.alive && !w.factions[b.faction].isNeutral && b.faction !== PLAYER && b.order.kind === 'befriend').length;

describe('a new player’s first minute', () => {
  it('every town starts with a few wanderers of its own, just outside its land', () => {
    for (const mode of ['casual', 'pro'] as ModeId[])
      for (const map of MAP_IDS)
        for (const size of SIZE_IDS)
          for (const rivals of [1, 2, 4, 6]) {
            const w = new World(MODES[mode], 5, { map, mapSize: size, rivals });
            const wild = w.blobs.filter((b) => b.faction === NEUTRAL);
            for (const f of w.factions) {
              if (f.isNeutral) continue;
              const h = w.hall(f.id)!;
              const near = wild.filter((b) => Math.hypot(b.x - h.x, b.y - h.y) < 480);
              expect(near.length, `${mode} ${map} ${size} ${rivals} rivals, team ${f.id}`).toBeGreaterThanOrEqual(2);
              // Nobody starts inside a town's land, except on Crowded Middle where the big camp is the point.
              if (map !== 'crowd') {
                for (const b of wild) expect(Math.hypot(b.x - h.x, b.y - h.y)).toBeGreaterThan(w.territoryRadius(f.id));
              }
            }
          }
  });

  it('casual rivals give you a minute before sending anyone out; pro rivals don’t wait', () => {
    const casual = new World(MODES.casual, 11);
    run(casual, MODES.casual.aiGrace - 5);
    expect(sentOut(casual)).toBe(0);
    run(casual, 40);
    expect(sentOut(casual)).toBeGreaterThan(0);

    const pro = new World(MODES.pro, 11);
    run(pro, 20);
    expect(sentOut(pro)).toBeGreaterThan(0);
  });

  it('the first-steps guide follows what you do, and points at the right thing', () => {
    const w = new World(MODES.casual, 4);
    const coach = new Coach(PLAYER, 'casual');
    expect(coach.step(w, [])).toBe(0);
    const [p0] = coach.points(w, []);
    const mine = w.blobs.find((b) => Math.abs(b.x - p0.x) < 1e-9 && Math.abs(b.y - 18 - p0.y) < 1e-9)!;
    expect(mine.faction).toBe(PLAYER);
    expect(mine.age).toBeGreaterThanOrEqual(ADULT_AGE);

    expect(coach.step(w, [mine])).toBe(1);
    const [p1] = coach.points(w, [mine]);
    const stranger = w.blobs.find((b) => Math.abs(b.x - p1.x) < 1e-9 && Math.abs(b.y - 18 - p1.y) < 1e-9)!;
    expect(stranger.faction).toBe(NEUTRAL);
    expect(coach.card(w, [mine]).text).toBe('Now tap the grey strangers');

    w.command({ type: 'befriendArea', faction: PLAYER, ids: [mine.id], x: stranger.x, y: stranger.y, r: 150, target: stranger.id });
    run(w, DT);
    expect(coach.step(w, [])).toBe(2);
    expect(coach.points(w, [])).toHaveLength(1);
  });

  it('brings buttons in one group at a time, and remembers them', () => {
    expect(UNLOCKS.flatMap((u) => u.features)).toEqual(ALL_FEATURES);
    expect(new Set(ALL_FEATURES).size).toBe(ALL_FEATURES.length);
    // Teach is there from the start, so it is never held back.
    expect(ALL_FEATURES as readonly string[]).not.toContain('teach');
    const ctx = { time: 0, madeFriend: false, hasSchool: false };
    expect(UNLOCKS[0].ready(ctx)).toBe(false);
    expect(UNLOCKS[0].ready({ ...ctx, madeFriend: true })).toBe(true);
    expect(UNLOCKS[2].ready({ ...ctx, hasSchool: true })).toBe(true);

    for (const u of UNLOCKS) {
      expect(nextUnlock()).toBe(u);
      unlock(u.features);
      for (const f of u.features) expect(unlocked().has(f)).toBe(true);
    }
    expect(nextUnlock()).toBeNull();
  });
});
