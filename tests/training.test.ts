import { describe, expect, it } from 'vitest';
import { MODES } from '../src/modes';
import { ADULT_AGE, CHILD_GROWTH, DT, PLAYER, lifeLength } from '../src/sim/config';
import { findSpot } from '../src/sim/systems/ai';
import { hit } from '../src/sim/systems/violence';
import { mentor } from '../src/sim/systems/social';
import { Rng } from '../src/sim/rng';
import { NATURAL_MAX, NEGATIVE_TRAITS, SKILL_MAX, TRAIT_KEYS, driftTraits, gradeOf, inheritTraits, payoff, randomTraits, skillShare, train, type Traits } from '../src/sim/traits';
import type { Blob } from '../src/sim/types';
import { World } from '../src/sim/world';

const all = (v: number): Traits => Object.fromEntries(TRAIT_KEYS.map((k) => [k, v])) as Traits;
const adults = (w: World): Blob[] => w.blobs.filter((b) => b.faction === PLAYER && b.role === 'citizen' && b.age >= ADULT_AGE);

/** Seconds of full-time study at a tech-0 school to get from 0.5 to `target`. */
function studyTime(target: number): number {
  const t = all(0.5);
  let sec = 0;
  while (t.finance < target && sec < 36000) {
    train(t, 'finance', 0.004 * DT);
    sec += DT;
  }
  return sec;
}

describe('living longer', () => {
  it('makes a hundred years last much longer, without making kids take ages to grow up', () => {
    expect(100 / MODES.casual.yearsPerSecond).toBeGreaterThan(20 * 60);
    expect(100 / MODES.pro.yearsPerSecond).toBeGreaterThan(15 * 60);
    for (const m of [MODES.casual, MODES.pro]) expect(ADULT_AGE / (m.yearsPerSecond * CHILD_GROWTH)).toBeLessThan(70);
  });

  it('lets a blob that trains its fitness live longer', () => {
    const b = adults(new World(MODES.casual, 1))[0];
    b.traits.fitness = 0.5;
    const before = lifeLength(b);
    b.traits.fitness = 2;
    expect(lifeLength(b) - before).toBeCloseTo(37.5);
  });
});

describe('skills', () => {
  it('has most blobs born mediocre, and none born great', () => {
    const rng = new Rng(5);
    const shares: number[] = [];
    for (let i = 0; i < 400; i++) {
      const t = randomTraits(rng);
      for (const k of TRAIT_KEYS) if (!NEGATIVE_TRAITS.has(k)) shares.push(skillShare(k, t[k]));
    }
    expect(shares.reduce((a, b) => a + b, 0) / shares.length).toBeLessThan(0.2);
    expect(Math.max(...shares)).toBeLessThanOrEqual(NATURAL_MAX / SKILL_MAX);
    expect(shares.filter((s) => gradeOf(s) === 'Mediocre').length / shares.length).toBeGreaterThan(0.8);
  });

  it('gets decent quickly, and excellent only after a lot of study', () => {
    const decent = studyTime(NATURAL_MAX);
    const excellent = studyTime(0.65 * SKILL_MAX);
    expect(excellent).toBeGreaterThan(3 * decent);
    expect(excellent).toBeGreaterThan(8 * 60);
    expect(excellent).toBeLessThan(15 * 60);
    expect(gradeOf(0.7)).toBe('Excellent');
  });

  it('never goes past the maximum, and violence stays on its own scale', () => {
    const t = all(0.5);
    for (let i = 0; i < 50000; i++) {
      train(t, 'finance', 0.05);
      train(t, 'violence', 0.05);
    }
    expect(t.finance).toBe(SKILL_MAX);
    expect(t.violence).toBe(1);
  });

  it('makes an expert worth many beginners', () => {
    expect(payoff(0.65 * SKILL_MAX) / payoff(0.5)).toBeGreaterThan(8);
  });

  it('only teaches past natural ability to actual students', () => {
    const w = new World(MODES.casual, 3);
    w.factions[PLAYER].gold = 1000;
    const [x, y] = findSpot(w, PLAYER, 'school')!;
    w.command({ type: 'build', faction: PLAYER, kind: 'school', x, y });
    w.tick(DT);
    const school = w.buildings.find((b) => b.kind === 'school' && b.faction === PLAYER)!;
    school.focus = 'finance';
    const [nearby, student] = adults(w);
    nearby.traits.finance = student.traits.finance = 0.95;
    w.command({ type: 'job', faction: PLAYER, ids: [student.id], job: 'student' });
    for (let i = 0; i < 240 / DT; i++) {
      w.tick(DT);
      w.drainEvents();
      nearby.x = school.x + 30; // Stays beside the school the whole time.
      nearby.y = school.y;
    }
    expect(nearby.traits.finance).toBeLessThan(1.01);
    expect(student.traits.finance).toBeGreaterThan(1.3);
  });

  it('keeps training through chats, and chats alone do not make an expert', () => {
    const expert = all(2);
    driftTraits(expert, all(0.3), 0.5);
    expect(expert.finance).toBe(2);
    const ordinary = all(0.9);
    for (let i = 0; i < 1000; i++) driftTraits(ordinary, all(3), 0.5);
    expect(ordinary.finance).toBeLessThanOrEqual(NATURAL_MAX);
  });

  it('gives the children of masters a head start, nothing like what their parents earned', () => {
    const rng = new Rng(9);
    const kids = Array.from({ length: 300 }, () => inheritTraits(all(2.5), all(2.5), rng, 0.09).teaching);
    const mean = kids.reduce((a, b) => a + b, 0) / kids.length;
    expect(mean).toBeGreaterThan(NATURAL_MAX);
    expect(mean).toBeLessThan(1.5);
  });

  it('never takes a student past their teacher', () => {
    const w = new World(MODES.casual, 4);
    const [teacher, student] = adults(w);
    teacher.traits.teaching = 2;
    teacher.traits.finance = 1.2;
    student.traits.finance = 1.15;
    for (let i = 0; i < 200; i++) mentor(w, teacher, student, {});
    expect(student.traits.finance).toBeCloseTo(1.2, 5);
  });

  it('cannot frighten a loyal, strong blob into switching sides', () => {
    const w = new World(MODES.pro, 6);
    const [bully, target] = adults(w);
    bully.faction = 3;
    Object.assign(target.traits, { allegiance: 2, strength: 2 });
    const team = target.faction;
    for (let i = 0; i < 500; i++) {
      target.health = 1;
      target.loyalty = 0.1;
      hit(w, bully, target);
    }
    expect(target.faction).toBe(team);
  });
});
