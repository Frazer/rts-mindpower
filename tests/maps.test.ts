import { describe, expect, it } from 'vitest';
import { MODES } from '../src/modes';
import { BUILDINGS, DT, NEUTRAL, PLAYER } from '../src/sim/config';
import { MAP_IDS, SIZES } from '../src/sim/maps';
import { World } from '../src/sim/world';

const run = (w: World, seconds: number, each?: () => void): void => {
  for (let i = 0; i < Math.round(seconds / DT) && !w.outcome; i++) {
    w.tick(DT);
    w.drainEvents();
    each?.();
  }
};

const inside = (w: World, x: number, y: number, pad: number): boolean =>
  w.obstacles.some((o) => (o.x - x) ** 2 + (o.y - y) ** 2 < (o.r + pad) ** 2);

describe('maps', () => {
  it('meadow is the plain map, with nothing in the way', () => {
    const a = new World(MODES.casual, 3);
    const b = new World(MODES.casual, 3, { map: 'meadow', mapSize: 'medium' });
    expect(b.obstacles).toEqual([]);
    expect(b.save()).toBe(a.save());
  });

  it('sizes scale the map and the wanderers', () => {
    const area = (s: 'small' | 'medium' | 'large') => {
      const w = new World(MODES.pro, 3, { mapSize: s });
      return { area: w.w * w.h, wild: w.blobs.filter((b) => b.faction === NEUTRAL).length };
    };
    const [s, m, l] = [area('small'), area('medium'), area('large')];
    expect(s.area / m.area).toBeCloseTo(SIZES.small.area, 1);
    expect(l.area / m.area).toBeCloseTo(SIZES.large.area, 1);
    expect(s.wild).toBeLessThan(m.wild);
    expect(l.wild).toBeGreaterThan(m.wild);
  });

  it('crowded middle packs most wanderers in the centre', () => {
    const w = new World(MODES.casual, 8, { map: 'crowd' });
    const wild = w.blobs.filter((b) => b.faction === NEUTRAL);
    const mid = wild.filter((b) => (b.x - w.w / 2) ** 2 + (b.y - w.h / 2) ** 2 < 260 ** 2);
    expect(mid.length / wild.length).toBeGreaterThan(0.6);
    expect(wild.length).toBe(Math.round(MODES.casual.neutrals * 1.5));
  });

  for (const map of ['lakes', 'woods'] as const) {
    for (const rivals of [1, 2, 5]) {
      it(`${map}, ${rivals} rival(s): obstacles stay clear of towns, blobs and buildings stay out of them`, () => {
        const w = new World(MODES.pro, 21 + rivals, { map, rivals });
        expect(w.obstacles.length).toBeGreaterThanOrEqual(map === 'lakes' ? 2 : 6);
        for (const f of w.factions.slice(1)) {
          const h = w.hall(f.id)!;
          expect(inside(w, h.x, h.y, 200)).toBe(false);
        }
        let worst = -Infinity;
        run(w, 300, () => {
          for (const b of w.blobs) {
            for (const o of w.obstacles) worst = Math.max(worst, o.r - Math.sqrt((o.x - b.x) ** 2 + (o.y - b.y) ** 2));
          }
        });
        // Never past the edge into a pond or a clump.
        expect(worst).toBeLessThan(0);
        for (const b of w.buildings) expect(inside(w, b.x, b.y, BUILDINGS[b.kind].radius)).toBe(false);
        expect(w.buildings.length).toBeGreaterThan(w.factions.length);
      });
    }
  }

  it('a blob sent across a pond walks round it and gets there', () => {
    const w = new World(MODES.pro, 5, { map: 'lakes', ai: false });
    const pond = [...w.obstacles].sort((a, b) => b.r - a.r)[0];
    const blob = w.blobs.find((b) => b.faction === PLAYER)!;
    // Start on one side of the pond, aim straight through it at the far side.
    const from = w.free(pond.x - pond.r - 40, pond.y);
    const to = w.free(pond.x + pond.r + 40, pond.y);
    blob.x = blob.px = from.x;
    blob.y = blob.py = from.y;
    w.command({ type: 'order', faction: PLAYER, ids: [blob.id], order: 'move', x: to.x, y: to.y });
    let t = 0;
    run(w, 40, () => {
      if (t === 0 && (blob.x - to.x) ** 2 + (blob.y - to.y) ** 2 < 40 ** 2) t = w.time;
    });
    expect(t).toBeGreaterThan(0);
  });

  it('every map is the same game for the same seed', () => {
    for (const map of MAP_IDS) {
      const a = new World(MODES.casual, 77, { map, rivals: 3, mapSize: 'large' });
      const b = new World(MODES.casual, 77, { map, rivals: 3, mapSize: 'large' });
      run(a, 60);
      run(b, 60);
      expect(b.hash(), map).toBe(a.hash());
    }
  });

  it('nobody can build on water', () => {
    const w = new World(MODES.casual, 5, { map: 'lakes' });
    const pond = w.obstacles[0];
    expect(w.canPlace(PLAYER, 'house', pond.x, pond.y).ok).toBe(false);
  });
});
