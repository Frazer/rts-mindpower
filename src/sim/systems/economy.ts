import { ADULT_AGE, MAX_TECH, NEUTRAL, SCHOOL_RADIUS, techThreshold } from '../config';
import type { Blob } from '../types';
import { clamp01 } from '../util';
import type { World } from '../world';

const near: Blob[] = [];

/** Gold from financial smarts, research from science + intelligence, schools teaching. */
export function economy(w: World, dt: number): void {
  const n = w.factions.length;
  const gold = new Array<number>(n).fill(0);
  const res = new Array<number>(n).fill(0);
  for (const b of w.blobs) {
    if (!b.alive || b.jail > 0 || b.faction === NEUTRAL) continue;
    const adult = b.age >= ADULT_AGE ? 1 : 0.5;
    gold[b.faction] += (0.03 + 0.12 * b.traits.finance) * adult;
    res[b.faction] += (0.6 * b.traits.science + 0.4 * b.traits.intelligence) * 0.2 * adult;
  }
  for (const f of w.factions) {
    if (f.isNeutral) continue;
    f.gold += gold[f.id] * dt * (1 + 0.25 * f.counts.market) * w.mode.incomeMult;
    f.research += res[f.id] * dt * (1 + 0.35 * f.counts.lab) * (1 + 0.05 * f.counts.school);
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
    const rate = dt * 0.004 * (1 + 0.1 * tech);
    w.grid.query(s.x, s.y, SCHOOL_RADIUS, near);
    for (const b of near) {
      if (b.faction !== s.faction || b.jail > 0) continue;
      const boost = b.age < ADULT_AGE ? 2 : 1; // kids learn faster
      b.traits[s.focus] = clamp01(b.traits[s.focus] + rate * boost);
      b.traits.intelligence = clamp01(b.traits.intelligence + rate * 0.35 * boost);
    }
  }
}
