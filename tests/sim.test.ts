import { describe, expect, it } from 'vitest';
import { MODES, type ModeId } from '../src/modes';
import { ADULT_AGE, DT, NEUTRAL, PLAYER } from '../src/sim/config';
import { World } from '../src/sim/world';
import type { SimEventType } from '../src/sim/types';

function run(mode: ModeId, seconds: number, seed = 42) {
  const w = new World(MODES[mode], seed);
  const counts: Partial<Record<SimEventType, number>> = {};
  const steps = Math.round(seconds / DT);
  for (let i = 0; i < steps && !w.outcome; i++) {
    w.tick(DT);
    for (const e of w.drainEvents()) counts[e.type] = (counts[e.type] ?? 0) + 1;
  }
  return { w, counts };
}

describe('simulation', () => {
  for (const mode of ['casual', 'pro'] as const) {
    it(`${mode}: runs 10 sim-minutes with sane state`, () => {
      const { w, counts } = run(mode, 600);
      for (const b of w.blobs) {
        expect(Number.isFinite(b.x) && Number.isFinite(b.y)).toBe(true);
        expect(b.x).toBeGreaterThanOrEqual(0);
        expect(b.x).toBeLessThanOrEqual(w.w);
        expect(b.loyalty).toBeLessThanOrEqual(1);
      }
      w.refreshCounts();
      const summary = w.factions.map((f) => ({
        name: f.name,
        pop: f.pop,
        tech: f.tech,
        gold: Math.round(f.gold),
        rep: +f.reputation.toFixed(2),
        police: f.police,
        buildings: Object.entries(f.counts).filter(([, n]) => n > 0).map(([k, n]) => `${k}:${n}`).join(' '),
        ...f.stats,
      }));
      console.log(`\n[${mode}] t=${Math.round(w.time)}s outcome=${JSON.stringify(w.outcome)}`);
      console.table(summary);
      console.log('events', counts);
      expect(counts.convert ?? 0).toBeGreaterThan(0);
      expect(counts.birth ?? 0).toBeGreaterThan(0);
    });
  }

  it('player can befriend a neutral blob', () => {
    const w = new World(MODES.casual, 7);
    const hall = w.hall(PLAYER)!;
    const d = (b: { x: number; y: number }): number => (b.x - hall.x) ** 2 + (b.y - hall.y) ** 2;
    const target = w.blobs.filter((b) => b.faction === NEUTRAL).sort((a, b) => d(a) - d(b))[0];
    w.command({ type: 'autoBefriend', faction: PLAYER, target: target.id });
    for (let i = 0; i < 90 / DT && target.faction === NEUTRAL && target.alive; i++) {
      w.tick(DT);
      // keep the target still so the test is about persuasion, not chasing
      target.x = target.px;
      target.y = target.py;
    }
    expect(target.faction).toBe(PLAYER);
  });

  it('teaching pulls a teammate toward the teacher’s strengths only', () => {
    const w = new World(MODES.casual, 11);
    const mine = w.blobs.filter((b) => b.faction === PLAYER && b.role === 'citizen' && b.age >= ADULT_AGE);
    const [teacher, student] = [mine[0], mine[1]];
    Object.assign(teacher.traits, { kindness: 0.95, teaching: 0.9, violence: 0.05, strength: 0.1 });
    Object.assign(student.traits, { kindness: 0.2, violence: 0.8, strength: 0.7 });
    student.x = teacher.x + 20;
    student.y = teacher.y;
    w.command({ type: 'order', faction: PLAYER, ids: [teacher.id], order: 'teach', target: student.id });
    let taught = '';
    for (let i = 0; i < 40 / DT && !taught; i++) {
      w.tick(DT);
      student.x = student.px;
      student.y = student.py;
      taught = w.drainEvents().find((e) => e.type === 'taught')?.text ?? '';
    }
    expect(taught).toContain(student.name);
    expect(student.traits.kindness).toBeGreaterThan(0.4); // learned
    expect(student.traits.violence).toBeLessThan(0.65); // calmed down
    expect(student.traits.strength).toBeGreaterThan(0.6); // teacher's weakness not copied
    expect(teacher.order.kind).toBe('none');
  });

  it('citizens live at different buildings, not just the town hall', () => {
    const w = new World(MODES.casual, 21);
    const hall = w.hall(PLAYER)!;
    const spots: [number, number][] = [[-160, 0], [160, 0], [0, -150], [0, 150]];
    for (const [dx, dy] of spots) w.placeBuilding(PLAYER, 'house', hall.x + dx, hall.y + dy);
    for (let i = 0; i < 40 / DT; i++) w.tick(DT);
    const mine = w.blobs.filter((b) => b.faction === PLAYER && b.role !== 'police');
    const homes = new Set(mine.map((b) => b.home));
    expect(homes.size).toBeGreaterThanOrEqual(3);
    const far = mine.filter((b) => (b.x - hall.x) ** 2 + (b.y - hall.y) ** 2 > 110 * 110).length;
    expect(far).toBeGreaterThan(mine.length / 3);
  });

  it('a group aimed at a crowd spreads out over it', () => {
    const w = new World(MODES.casual, 5);
    const hall = w.hall(PLAYER)!;
    const crowd = w.blobs.filter((b) => b.faction === NEUTRAL).slice(0, 5);
    crowd.forEach((b, i) => {
      b.x = b.px = hall.x + 220 + (i % 3) * 30;
      b.y = b.py = hall.y + Math.floor(i / 3) * 30;
    });
    const group = w.blobs.filter((b) => b.faction === PLAYER && b.role === 'citizen' && b.age >= ADULT_AGE).slice(0, 4);
    w.command({ type: 'befriendArea', faction: PLAYER, ids: group.map((b) => b.id), x: hall.x + 250, y: hall.y + 15, r: 150 });
    w.tick(DT);
    const targets = new Set(group.map((b) => (b.order.kind === 'befriend' ? b.order.target : -1)));
    expect(targets.has(-1)).toBe(false);
    expect(targets.size).toBe(4); // everyone took a different stranger
    for (let i = 0; i < 120 / DT; i++) {
      w.tick(DT);
      for (const c of crowd) {
        if (c.faction !== NEUTRAL) continue;
        c.x = c.px;
        c.y = c.py;
      }
    }
    expect(crowd.filter((c) => c.faction === PLAYER).length).toBeGreaterThanOrEqual(4);
  });

  it('a friendship fountain befriends strangers standing near it', () => {
    const w = new World(MODES.casual, 8);
    const hall = w.hall(PLAYER)!;
    const f = w.placeBuilding(PLAYER, 'fountain', hall.x + 150, hall.y);
    const visitor = w.blobs.find((b) => b.faction === NEUTRAL)!;
    for (let i = 0; i < 60 / DT && visitor.faction === NEUTRAL; i++) {
      visitor.x = visitor.px = f.x + 40;
      visitor.y = visitor.py = f.y + 30;
      w.tick(DT);
    }
    expect(visitor.faction).toBe(PLAYER);
  });

  it('outnumbering the blobs at a rival building takes it over', () => {
    const w = new World(MODES.casual, 9);
    const hall = w.hall(PLAYER)!;
    // A lonely rival market at the edge of our land.
    const market = w.placeBuilding(3, 'market', hall.x + 230, hall.y);
    const group = w.blobs.filter((b) => b.faction === PLAYER && b.role === 'citizen').slice(0, 5);
    w.command({ type: 'order', faction: PLAYER, ids: group.map((b) => b.id), order: 'usurp', building: market.id });
    let took = false;
    for (let i = 0; i < 90 / DT && !took; i++) {
      w.tick(DT);
      took = w.drainEvents().some((e) => e.type === 'usurp' && e.target === market.id);
    }
    expect(took).toBe(true);
    expect(market.faction).toBe(PLAYER);
  });

  it('police arrest attackers inside their town', () => {
    // Catching is a dice roll and attackers can outrun low-tech police, so check several towns.
    let caught = 0;
    for (const seed of [1, 2, 3, 4, 5]) {
      const w = new World(MODES.pro, seed);
      const hall = w.hall(PLAYER)!;
      const mine = w.blobs.filter((b) => b.faction === PLAYER && b.role === 'citizen' && b.age >= ADULT_AGE);
      const [thug, victim] = [mine[0], mine[1]];
      thug.x = victim.x = hall.x + 30;
      thug.y = victim.y = hall.y + 30;
      victim.faction = 3; // pretend victim is a rival visitor
      let arrested = false;
      w.command({ type: 'order', faction: PLAYER, ids: [thug.id], order: 'attack', target: victim.id });
      for (let i = 0; i < 60 / DT && !arrested; i++) {
        w.tick(DT);
        arrested = w.drainEvents().some((e) => e.type === 'arrest' && e.blob === thug.id);
      }
      if (arrested) caught++;
    }
    expect(caught).toBeGreaterThanOrEqual(3);
  });
});
