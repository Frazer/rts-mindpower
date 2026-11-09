import { ADULT_AGE, NEUTRAL, TALK_RANGE } from '../config';
import { NATURAL_MAX, NEGATIVE_TRAITS, TRAIT_INFO, TRAIT_KEYS, driftTraits, payoff, skillShare, talkScore, train, type TraitKey } from '../traits';
import type { Blob } from '../types';
import { clamp01, dist2 } from '../util';
import type { World } from '../world';

const near: Blob[] = [];

/** Lessons per Teach order (one every ~1–1.5 s). */
export const TEACH_SESSIONS = 8;
/** However far ahead a teacher is, a student only takes in this much at once. */
const LESSON_GAP = 0.15;
type Gains = Partial<Record<TraitKey, number>>;

/**
 * Conversation: the heart of the game. Blobs chat with neighbours; each chat
 * pulls the other's loyalty toward the speaker's faction and spreads traits.
 */
export function social(w: World, _dt: number): void {
  for (const b of w.blobs) {
    if (!b.alive || b.jail > 0 || b.stun > 0 || b.talkCd > 0) continue;
    const o = b.order;

    if (o.kind === 'befriend') {
      const t = w.byId.get(o.target);
      if (!t || !t.alive) continue;
      if (dist2(b.x, b.y, t.x, t.y) > TALK_RANGE * TALK_RANGE) continue;
      b.talkCd = chatPause(b);
      t.talkCd = Math.max(t.talkCd, 1.0);
      talk(w, b, t, true);
      o.tries++;
      if (t.faction === b.faction || o.tries >= 12) w.endOrder(b);
      continue;
    }
    if (o.kind === 'teach') {
      const t = w.byId.get(o.target);
      if (!t || !t.alive) continue;
      if (dist2(b.x, b.y, t.x, t.y) > TALK_RANGE * TALK_RANGE) continue;
      b.talkCd = chatPause(b);
      t.talkCd = Math.max(t.talkCd, 1.0);
      mentor(w, b, t, o.gain);
      if (++o.tries >= TEACH_SESSIONS) {
        w.factions[b.faction].stats.lessons++;
        w.emit('taught', t.x, t.y, { faction: b.faction, blob: b.id, target: t.id, text: taughtText(w, b, t, o.gain), manual: b.byPlayer });
        w.endOrder(b);
      }
      continue;
    }
    if (o.kind !== 'none' && o.kind !== 'move') continue;

    b.talkCd = w.rng.range(2.5, 5.5);
    if (w.rng.chance(0.35)) continue;
    w.grid.query(b.x, b.y, TALK_RANGE * 1.3, near);
    let pick: Blob | null = null;
    let n = 0;
    for (const c of near) {
      if (c === b || c.jail > 0) continue;
      n++;
      if (w.rng.next() * n < 1) pick = c;
    }
    if (!pick) continue;
    pick.talkCd = Math.max(pick.talkCd, 1.5);
    talk(w, b, pick, false);
  }
}

const chatPause = (b: Blob): number => 1.0 + Math.max(0, 1 - b.traits.patience) * 0.5;

/** How much of what a speaker knows rubs off on a listener in a chat. */
function chatRate(speaker: Blob, listener: Blob): number {
  return 0.012 * Math.min(NATURAL_MAX, speaker.traits.teaching) * (0.3 + 0.7 * Math.min(NATURAL_MAX, listener.traits.openness));
}

export function talk(w: World, a: Blob, b: Blob, focused: boolean): void {
  influence(w, a, b, focused);
  influence(w, b, a, false);
  const same = a.faction === b.faction;
  const cross = same ? 1 : 0.5;
  const schoolA = w.hasSchoolNear(a.faction, a.x, a.y) ? 1.5 : 1;
  driftTraits(b.traits, a.traits, chatRate(a, b) * cross * schoolA);
  driftTraits(a.traits, b.traits, chatRate(b, a) * cross);
  a.lookAt = b.id;
  b.lookAt = a.id;
  if (same) {
    a.mood = b.mood = 'happy';
    a.moodTime = b.moodTime = 1.5;
  }
  if (focused || w.rng.chance(0.25)) {
    w.emit('talk', (a.x + b.x) / 2, (a.y + b.y) / 2, { faction: a.faction, other: b.faction, blob: a.id, target: b.id });
  }
}

/** Speaker `s` tries to win over receiver `r`. */
function influence(w: World, s: Blob, r: Blob, focused: boolean): void {
  if (r.jail > 0 || !r.alive) return;
  if (s.faction === r.faction) {
    r.loyalty = Math.min(w.loyaltyCap(r), r.loyalty + 0.012 + 0.02 * s.traits.kindness);
    return;
  }
  let pull = payoff(talkScore(s.traits));
  if (s.faction === NEUTRAL) {
    pull *= 0.35;
  } else {
    const fs = w.factions[s.faction];
    pull *= (0.5 + fs.reputation) * (1 + 0.05 * fs.tech) * w.mode.conversionMult;
    if (w.hasSchoolNear(s.faction, s.x, s.y)) pull *= 1.15;
  }
  // Grudges from past violence make a faction hard to win over.
  pull *= 1 - 0.75 * w.factions[r.faction].grudge[s.faction];
  if (focused || s.role === 'ambassador') pull *= 1.35;
  if (r.role === 'police') pull *= 0.4;
  else if (r.role === 'ambassador') pull *= 0.5;
  const receptivity = 0.35 + 0.65 * Math.min(NATURAL_MAX, r.traits.openness);
  r.loyalty -= pull * receptivity * 0.13;
  if (r.loyalty <= 0) w.convert(r, s.faction, 'talk');
}

/**
 * One lesson: the student's traits move toward the teacher's, but only where the
 * teacher is better (higher, or calmer for violence). Good teachers, patient
 * students, kids, schools and tech all speed it up, and it gets harder the better
 * the student already is. Nobody learns more than their teacher knows.
 */
export function mentor(w: World, teacher: Blob, student: Blob, gain: Gains): void {
  const kid = student.age < ADULT_AGE ? 2 : 1;
  const school = w.hasSchoolNear(teacher.faction, teacher.x, teacher.y) ? 1.5 : 1;
  const tech = 1 + 0.05 * w.factions[teacher.faction].tech;
  // A master teacher is better than a good one, but not three times better.
  const skill = 0.5 + Math.min(1, teacher.traits.teaching) + 0.25 * Math.max(0, teacher.traits.teaching - 1);
  const rate = Math.min(0.5, 0.08 * skill * (0.6 + 0.4 * student.traits.patience) * kid * school * tech);
  for (const k of TRAIT_KEYS) {
    const gap = teacher.traits[k] - student.traits[k];
    if (NEGATIVE_TRAITS.has(k) ? gap >= 0 : gap <= 0) continue;
    const before = student.traits[k];
    if (NEGATIVE_TRAITS.has(k)) student.traits[k] = clamp01(before + gap * rate);
    else train(student.traits, k, Math.min(gap, LESSON_GAP) * rate);
    // Never past the teacher.
    if (!NEGATIVE_TRAITS.has(k)) student.traits[k] = Math.min(student.traits[k], teacher.traits[k]);
    gain[k] = (gain[k] ?? 0) + Math.abs(student.traits[k] - before);
  }
  student.loyalty = Math.min(w.loyaltyCap(student), student.loyalty + 0.02 + 0.02 * teacher.traits.kindness);
  teacher.lookAt = student.id;
  student.lookAt = teacher.id;
  teacher.mood = student.mood = 'happy';
  teacher.moodTime = student.moodTime = 1.5;
  w.emit('teach', (teacher.x + student.x) / 2, (teacher.y + student.y) / 2, { faction: teacher.faction, blob: teacher.id, target: student.id });
}

function taughtText(w: World, teacher: Blob, student: Blob, gain: Gains): string {
  const top = (Object.entries(gain) as [TraitKey, number][])
    .filter(([, v]) => v >= 0.005)
    .sort((a, z) => z[1] - a[1])
    .slice(0, 3);
  if (!top.length) return `${student.name} already knew everything ${teacher.name} could teach`;
  const parts = top.map(([k, v]) => {
    const t = TRAIT_INFO[k];
    const neg = NEGATIVE_TRAITS.has(k);
    if (w.mode.showNumbers) return `${t.icon} ${t.label} ${neg ? '−' : '+'}${Math.max(1, Math.round(skillShare(k, v) * 100))}`;
    return neg ? '😌 Calmness' : `${t.icon} ${t.label}`;
  });
  if (w.mode.showNumbers) return `${teacher.name} taught ${student.name}: ${parts.join(', ')}`;
  const list = parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}` : parts[0];
  return `${student.name} learned ${list} from ${teacher.name}`;
}
