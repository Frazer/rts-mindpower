import { describe, expect, it } from 'vitest';
import { MODES } from '../src/modes';
import { DT, HALL_CAP, HALL_LEVEL_CAP, HOUSE_CAP, MAX_LEVEL, PLAYER, buildCost, fountainRadius, levelSpeed, schoolRadius, upgradeCost } from '../src/sim/config';
import { findSpot } from '../src/sim/systems/ai';
import type { Building, BuildingKind } from '../src/sim/types';
import { World } from '../src/sim/world';

function town(gold = 100000): World {
  const w = new World(MODES.casual, 7);
  w.factions[PLAYER].gold = gold;
  return w;
}

function build(w: World, kind: BuildingKind): Building {
  const [x, y] = findSpot(w, PLAYER, kind)!;
  w.command({ type: 'build', faction: PLAYER, kind, x, y });
  w.tick(DT);
  w.drainEvents();
  return w.buildings.filter((b) => b.kind === kind && b.faction === PLAYER).at(-1)!;
}

function levelUp(w: World, b: Building, faction = PLAYER): void {
  w.command({ type: 'upgrade', faction, building: b.id });
  w.tick(DT);
  w.drainEvents();
}

describe('levelling up buildings', () => {
  it('starts at the price of building another, charges gold, and climbs', () => {
    const w = town();
    const house = build(w, 'house');
    const f = w.factions[PLAYER];
    expect(house.level).toBe(1);
    const first = upgradeCost(f, house);
    expect(first).toBe(buildCost(f, 'house'));
    const before = f.gold;
    w.command({ type: 'upgrade', faction: PLAYER, building: house.id });
    w.tick(DT);
    expect(house.level).toBe(2);
    expect(before - f.gold).toBeGreaterThan(first - 5); // A tick of income lands on top.
    expect(before - f.gold).toBeLessThanOrEqual(first);
    expect(upgradeCost(f, house)).toBeGreaterThan(first);
  });

  it('stops at the top level', () => {
    const w = town();
    const hall = w.hall(PLAYER)!;
    for (let i = 0; i < MAX_LEVEL + 3; i++) levelUp(w, hall);
    expect(hall.level).toBe(MAX_LEVEL);
  });

  it('needs enough gold, and only works on your own buildings', () => {
    const w = town(0);
    const hall = w.hall(PLAYER)!;
    levelUp(w, hall);
    expect(hall.level).toBe(1);
    const rival = w.buildings.find((b) => b.faction !== PLAYER && b.faction !== 0)!;
    w.factions[PLAYER].gold = 100000;
    levelUp(w, rival);
    expect(rival.level).toBe(1);
  });

  it('adds room', () => {
    const w = town();
    w.tick(DT);
    const f = w.factions[PLAYER];
    expect(f.cap).toBe(HALL_CAP);
    levelUp(w, w.hall(PLAYER)!);
    w.tick(DT);
    expect(f.cap).toBe(HALL_CAP + HALL_LEVEL_CAP);
    const house = build(w, 'house');
    levelUp(w, house);
    w.tick(DT);
    expect(f.cap).toBe(HALL_CAP + HALL_LEVEL_CAP + 2 * HOUSE_CAP);
  });

  it('makes one levelled-up market earn like two', () => {
    const income = (levels: number): number => {
      const w = town(50000);
      const market = build(w, 'market');
      for (let i = 1; i < levels; i++) levelUp(w, market);
      w.tick(DT);
      const f = w.factions[PLAYER];
      const before = f.gold;
      w.tick(DT);
      return f.gold - before;
    };
    expect(income(3) / income(1)).toBeCloseTo((1 + 0.25 * 3) / (1 + 0.25), 1);
  });

  it('widens and speeds up schools and fountains', () => {
    const w = town();
    const school = build(w, 'school');
    const fountain = build(w, 'fountain');
    const s0 = schoolRadius(school);
    const f0 = fountainRadius(fountain);
    levelUp(w, school);
    levelUp(w, fountain);
    expect(schoolRadius(school)).toBeGreaterThan(s0);
    expect(fountainRadius(fountain)).toBeGreaterThan(f0);
    expect(levelSpeed(school)).toBeCloseTo(1.25);
  });

  it('keeps its level when taken, but holds out longer first', () => {
    const takeover = (levels: number): { sec: number; level: number } => {
      const w = town();
      const market = build(w, 'market');
      for (let i = 1; i < levels; i++) levelUp(w, market);
      const rival = w.factions.find((f) => !f.isNeutral && f.id !== PLAYER)!;
      const crowd = w.blobs.filter((b) => b.faction === rival.id && b.role === 'citizen').slice(0, 6);
      w.command({ type: 'order', faction: rival.id, ids: crowd.map((b) => b.id), order: 'usurp', building: market.id });
      let sec = 0;
      while (market.faction === PLAYER && sec < 900) {
        for (const b of crowd) {
          b.x = market.x + 20;
          b.y = market.y + 20;
        }
        w.tick(DT);
        w.drainEvents();
        sec += DT;
      }
      return { sec, level: market.level };
    };
    const plain = takeover(1);
    const strong = takeover(3);
    expect(strong.level).toBe(3);
    expect(strong.sec).toBeGreaterThan(plain.sec * 1.3);
  });

  it('counts in the sync check and survives a snapshot', () => {
    const w = town();
    const hall = w.hall(PLAYER)!;
    const a = new World(MODES.casual, 7);
    a.load(w.save());
    expect(a.hash()).toBe(w.hash());
    hall.level = 3;
    expect(a.hash()).not.toBe(w.hash());
    a.load(w.save());
    expect(a.buildings.find((b) => b.id === hall.id)!.level).toBe(3);
    expect(a.hash()).toBe(w.hash());
  });

  it('plays out the same for every player online', () => {
    const play = (): number => {
      const w = town();
      levelUp(w, w.hall(PLAYER)!);
      levelUp(w, build(w, 'market'));
      for (let i = 0; i < 60 / DT; i++) {
        w.tick(DT);
        w.drainEvents();
      }
      return w.hash();
    };
    expect(play()).toBe(play());
  });

  it('gets the AI spending too', () => {
    const w = new World(MODES.casual, 11);
    for (const f of w.factions) if (f.ai) f.gold = 5000;
    for (let i = 0; i < 60 / DT; i++) {
      w.tick(DT);
      w.drainEvents();
    }
    const rivals = w.buildings.filter((b) => b.faction !== PLAYER && b.faction !== 0);
    expect(rivals.some((b) => b.level > 1)).toBe(true);
  });
});
