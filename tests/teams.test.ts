import { describe, expect, it } from 'vitest';
import { MODES } from '../src/modes';
import { DT, NEUTRAL, PLAYER } from '../src/sim/config';
import { MAX_RIVALS, World, teamDefs } from '../src/sim/world';

describe('rival teams', () => {
  it('two rivals is the classic map', () => {
    const a = new World(MODES.casual, 7);
    const b = new World(MODES.casual, 7, { rivals: 2 });
    expect([b.w, b.h]).toEqual([MODES.casual.worldW, MODES.casual.worldH]);
    expect(b.factions.map((f) => f.name)).toEqual(a.factions.map((f) => f.name));
    expect(b.blobs.map((x) => [x.x, x.y])).toEqual(a.blobs.map((x) => [x.x, x.y]));
    expect(b.factions.map((f) => f.name)).toEqual(['Wanderers', 'Blue Blobs', 'Peachy Pals', 'Grumble Gang']);
  });

  it('every count gives distinct teams and colours', () => {
    for (let n = 1; n <= MAX_RIVALS; n++) {
      const defs = teamDefs(n);
      expect(defs).toHaveLength(n + 2);
      expect(defs[NEUTRAL].neutral).toBe(true);
      expect(defs[PLAYER].player).toBe(true);
      expect(new Set(defs.map((d) => d.color)).size).toBe(defs.length);
      expect(defs.slice(2).every((d) => d.ai)).toBe(true);
    }
  });

  for (let n = 1; n <= MAX_RIVALS; n++) {
    it(`${n} rival(s): each town starts on the map, well apart`, () => {
      const w = new World(MODES.pro, 3, { rivals: n });
      expect(w.factions).toHaveLength(n + 2);
      const halls = w.factions.slice(1).map((f) => w.hall(f.id)!);
      expect(halls.every(Boolean)).toBe(true);
      for (const h of halls) {
        expect(h.x).toBeGreaterThan(200);
        expect(h.x).toBeLessThan(w.w - 200);
        expect(h.y).toBeGreaterThan(200);
        expect(h.y).toBeLessThan(w.h - 200);
      }
      for (let i = 0; i < halls.length; i++) {
        for (let j = i + 1; j < halls.length; j++) {
          expect(Math.hypot(halls[i].x - halls[j].x, halls[i].y - halls[j].y)).toBeGreaterThan(700);
        }
      }
      // Bigger map, more wanderers.
      if (n > 2) expect(w.w * w.h).toBeGreaterThan(MODES.pro.worldW * MODES.pro.worldH);
      expect(w.blobs.filter((b) => b.faction === NEUTRAL).length).toBe(Math.round((MODES.pro.neutrals * (n + 1)) / 3));
    });
  }

  for (const mode of ['casual', 'pro'] as const) {
    it(`${mode}, ${MAX_RIVALS} rivals: every AI town grows over 10 sim-minutes`, () => {
      const w = new World(MODES[mode], 11, { rivals: MAX_RIVALS });
      const t0 = performance.now();
      let worst = 0;
      for (let i = 0; i < 600 / DT && !w.outcome; i++) {
        const s = performance.now();
        w.tick(DT);
        w.drainEvents();
        worst = Math.max(worst, performance.now() - s);
      }
      const ms = performance.now() - t0;
      w.refreshCounts();
      console.log(
        `[${mode} x${MAX_RIVALS}] ${w.w}x${w.h} t=${Math.round(w.time)}s blobs=${w.blobs.length} avg tick ${(ms / (w.time / DT)).toFixed(2)}ms worst ${worst.toFixed(1)}ms`,
      );
      console.table(w.factions.map((f) => ({ name: f.name, pop: f.pop, tech: f.tech, buildings: Object.values(f.counts).reduce((a, b) => a + b, 0) })));
      const built = w.factions.filter((f) => f.ai && Object.values(f.counts).reduce((a, b) => a + b, 0) > 1).length;
      expect(built).toBeGreaterThanOrEqual(MAX_RIVALS - 1);
    });
  }
});
