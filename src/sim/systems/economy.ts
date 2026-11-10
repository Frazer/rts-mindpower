import { ADULT_AGE, MAX_TECH, NEUTRAL, levelSpeed, schoolRadius, techThreshold } from '../config';
import { NATURAL_MAX, TRAIT_INFO, gradeOf, payoff, skillShare, train, type TraitKey } from '../traits';
import type { Blob } from '../types';
import type { World } from '../world';

const near: Blob[] = [];

/** Being near a school teaches a bit, compared with actually studying there. */
const JUST_NEARBY = 0.4;
/** Students are too busy to earn much. */
const STUDENT_WORK = 0.5;

function attend(b: Blob, k: TraitKey, amount: number): void {
  if (b.job === 'student') train(b.traits, k, amount);
  else if (b.traits[k] < NATURAL_MAX) train(b.traits, k, amount * JUST_NEARBY);
}

/** Gold from financial smarts, research from science + intelligence, schools teaching. */
export function economy(w: World, dt: number): void {
  const n = w.factions.length;
  const gold = new Array<number>(n).fill(0);
  const res = new Array<number>(n).fill(0);
  for (const b of w.blobs) {
    if (!b.alive || b.jail > 0 || b.faction === NEUTRAL) continue;
    const adult = (b.age >= ADULT_AGE ? 1 : 0.5) * (b.job === 'student' ? STUDENT_WORK : 1);
    gold[b.faction] += (0.03 + 0.12 * payoff(b.traits.finance)) * adult;
    res[b.faction] += (0.6 * b.traits.science + 0.4 * b.traits.intelligence) * 0.2 * adult;
  }
  for (const f of w.factions) {
    if (f.isNeutral) continue;
    const income = gold[f.id] * dt * (1 + 0.25 * f.levels.market) * w.mode.incomeMult;
    f.gold += income;
    f.earned += income;
    f.research += res[f.id] * dt * (1 + 0.35 * f.levels.lab) * (1 + 0.05 * f.levels.school);
    while (f.tech < MAX_TECH && f.research >= techThreshold(f.tech + 1)) {
      f.tech++;
      const h = w.hall(f.id);
      w.emit('tech', h?.x ?? 0, h?.y ?? 0, { faction: f.id, text: `Tech level ${f.tech}` });
    }
    f.reputation += (0.65 - f.reputation) * Math.min(1, dt * 0.01);
    for (let i = 0; i < n; i++) f.grudge[i] = Math.max(0, f.grudge[i] - dt * 0.006);
  }

  // Schools teach their focus trait to members nearby.
  for (const s of w.buildings) {
    if (s.kind !== 'school') continue;
    const tech = w.factions[s.faction].tech;
    const rate = dt * 0.004 * (1 + 0.1 * tech) * levelSpeed(s);
    w.grid.query(s.x, s.y, schoolRadius(s), near);
    for (const b of near) {
      if (b.faction !== s.faction || b.jail > 0) continue;
      const boost = b.age < ADULT_AGE ? 2 : 1; // kids learn faster
      const was = gradeOf(skillShare(s.focus, b.traits[s.focus]));
      attend(b, s.focus, rate * boost);
      attend(b, 'intelligence', rate * 0.35 * boost);
      const now = gradeOf(skillShare(s.focus, b.traits[s.focus]));
      if (now !== was && b.job === 'student') {
        w.emit('notice', b.x, b.y, { faction: b.faction, blob: b.id, text: `🎓 ${b.name} is now ${now} at ${TRAIT_INFO[s.focus].label}!` });
      }
    }
  }
}
