import { ADULT_AGE, NEUTRAL } from '../config';
import { NEGATIVE_TRAITS, TRAIT_KEYS, type Traits } from '../traits';
import type { Blob } from '../types';
import { dist2 } from '../util';
import type { World } from '../world';

const near: Blob[] = [];

/** How far a teacher looks for students, and a recruiter for strangers. */
export const TEACH_SCAN = 170;
export const RECRUIT_SCAN = 320;
/** A student can't be picked by another job teacher for this long after a lesson starts. */
const LESSON_COOLDOWN = 30;

/** How much `student` could learn from `teacher` (sum of the gaps where the teacher is better). */
export function lessonValue(teacher: Traits, student: Traits): number {
  let v = 0;
  for (const k of TRAIT_KEYS) {
    const gap = teacher[k] - student[k];
    v += NEGATIVE_TRAITS.has(k) ? Math.max(0, -gap) : Math.max(0, gap);
  }
  return v;
}

export function isStranger(b: Blob, t: Blob): boolean {
  return t.alive && t.faction !== b.faction && t.role !== 'police' && t.jail <= 0;
}

/**
 * Standing jobs and group befriending. Whenever a blob with a job (or an
 * area to befriend) is idle, give it its next lesson or next stranger.
 */
export function jobs(w: World, dt: number): void {
  for (const b of w.blobs) {
    if (b.lessonCd > 0) b.lessonCd -= dt;
    if (!b.alive || b.jail > 0 || b.faction === NEUTRAL || b.role === 'police') continue;
    if (b.order.kind !== 'none') continue;
    if (b.jobCd > 0) {
      b.jobCd -= dt;
      continue;
    }
    if (b.area) {
      if (w.time > b.area.until || !befriendInArea(w, b)) b.area = null;
      b.jobCd = 0.3;
      continue;
    }
    if (b.job === 'teacher') b.jobCd = findStudent(w, b) ? 0.5 : 2.5;
    else if (b.job === 'recruiter') b.jobCd = findStranger(w, b) ? 0.5 : 3;
    else b.jobCd = 2;
  }
}

function findStudent(w: World, t: Blob): boolean {
  // Look around the teacher, and around its home if it has wandered off.
  w.grid.query(t.x, t.y, TEACH_SCAN, near);
  let best: Blob | null = null;
  let bestScore = 0.12;
  for (const c of near) {
    if (c === t || c.faction !== t.faction || c.jail > 0 || !c.alive || c.lessonCd > 0) continue;
    if (c.order.kind === 'teach') continue;
    const score = lessonValue(t.traits, c.traits) * (c.age < ADULT_AGE ? 1.4 : 1) - Math.sqrt(dist2(t.x, t.y, c.x, c.y)) / 900;
    if (score > bestScore) {
      bestScore = score;
      best = c;
    }
  }
  if (!best) return false;
  best.lessonCd = LESSON_COOLDOWN;
  t.order = { kind: 'teach', target: best.id, tries: 0, gain: {} };
  return true;
}

function strangerScore(w: World, b: Blob, t: Blob): number {
  const grudge = w.factions[t.faction].grudge[b.faction] ?? 0;
  return Math.sqrt(dist2(b.x, b.y, t.x, t.y)) * (t.faction === NEUTRAL ? 1 : 1.4) * (1 + 3 * grudge) * (0.6 + t.loyalty);
}

function findStranger(w: World, b: Blob): boolean {
  w.grid.query(b.x, b.y, RECRUIT_SCAN, near);
  let best: Blob | null = null;
  let bestScore = Infinity;
  for (const t of near) {
    if (!isStranger(b, t)) continue;
    const s = strangerScore(w, b, t);
    if (s < bestScore) {
      bestScore = s;
      best = t;
    }
  }
  if (!best) {
    // Nobody close: head for the nearest stranger within reach of home.
    for (const t of w.blobs) {
      if (!isStranger(b, t) || dist2(b.homeX, b.homeY, t.x, t.y) > 800 * 800) continue;
      const s = strangerScore(w, b, t);
      if (s < bestScore) {
        bestScore = s;
        best = t;
      }
    }
  }
  if (!best) return false;
  b.order = { kind: 'befriend', target: best.id, tries: 0 };
  b.role = 'ambassador';
  return true;
}

/** Crowds drift, so look a little past the circle that was tapped. */
const AREA_SLACK = 90;

function befriendInArea(w: World, b: Blob): boolean {
  const a = b.area!;
  w.grid.query(a.x, a.y, a.r + AREA_SLACK, near);
  let best: Blob | null = null;
  let bd = Infinity;
  for (const t of near) {
    if (!isStranger(b, t)) continue;
    const d = dist2(b.x, b.y, t.x, t.y);
    if (d < bd) {
      bd = d;
      best = t;
    }
  }
  if (!best) return false;
  b.order = { kind: 'befriend', target: best.id, tries: 0 };
  b.role = 'ambassador';
  b.byPlayer = true;
  return true;
}
