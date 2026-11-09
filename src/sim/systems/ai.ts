import { ADULT_AGE, BUILD_MENU, MAX_LEVEL, buildCost, upgradeCost } from '../config';
import { SKILL_MAX, talkScore, type TraitKey } from '../traits';
import type { Blob, Building, BuildingKind, Faction } from '../types';
import { cos, dist2, sin } from '../util';
import type { World } from '../world';

/** Simple rival AI: build, send ambassadors, and (if aggressive) pick fights. */
export function ai(w: World, dt: number): void {
  for (const f of w.factions) {
    if (!f.ai) continue;
    f.aiTimer -= dt;
    if (f.aiTimer > 0) continue;
    f.aiTimer = w.mode.aiThink * w.rng.range(0.7, 1.3);
    if (f.pop === 0) continue;
    aiBuild(w, f);
    aiUpgrade(w, f);
    aiJobs(w, f);
    aiDiplomacy(w, f);
    aiAggression(w, f);
    aiUsurp(w, f);
  }
}

function aiBuild(w: World, f: Faction): void {
  let kind: BuildingKind | null = null;
  if (f.pop >= f.cap - 1) {
    kind = 'house';
  } else {
    const weights = f.ai!.weights;
    // React to crime: more police if we've been attacked lately.
    const crime = f.grudge.reduce((a, b) => a + b, 0);
    const options = BUILD_MENU.filter((k) => buildCost(f, k) <= f.gold - 10);
    let total = 0;
    const ws = options.map((k) => {
      let wt = weights[k] ?? 1;
      if (k === 'police') wt += crime * 3;
      total += wt;
      return wt;
    });
    let roll = w.rng.next() * total;
    for (let i = 0; i < options.length; i++) {
      roll -= ws[i];
      if (roll <= 0) {
        kind = options[i];
        break;
      }
    }
  }
  if (!kind || f.gold < buildCost(f, kind)) return;
  const spot = findSpot(w, f.id, kind);
  if (spot) w.command({ type: 'build', faction: f.id, kind, x: spot[0], y: spot[1] });
}

/** Keeps this much of an upgrade's price spare, so it can still afford new buildings. */
const AI_UPGRADE_SPARE = 1.5;

/** Spare gold goes on the cheapest level-up, or on room if the town is full. */
function aiUpgrade(w: World, f: Faction): void {
  const full = f.pop >= f.cap - 1;
  let best: Building | null = null;
  let cost = Infinity;
  for (const b of w.buildings) {
    if (b.faction !== f.id || b.level >= MAX_LEVEL || (full && b.kind !== 'house' && b.kind !== 'hall')) continue;
    const c = upgradeCost(f, b);
    if (c < cost) {
      cost = c;
      best = b;
    }
  }
  if (best && f.gold >= cost * AI_UPGRADE_SPARE) w.command({ type: 'upgrade', faction: f.id, building: best.id });
}

export function findSpot(w: World, faction: number, kind: BuildingKind): [number, number] | null {
  const own = w.buildings.filter((b) => b.faction === faction);
  if (own.length === 0) return null;
  const r = w.territoryRadius(faction);
  for (let i = 0; i < 30; i++) {
    const base = w.rng.pick(own);
    const a = w.rng.range(0, Math.PI * 2);
    const d = w.rng.range(70, r - 20);
    const x = base.x + cos(a) * d;
    const y = base.y + sin(a) * d;
    if (w.canPlace(faction, kind, x, y).ok) return [x, y];
  }
  return null;
}

function aiDiplomacy(w: World, f: Faction): void {
  const want = Math.round(1 + f.ai!.diplomacy * 2 + f.tech * 0.25);
  let current = 0;
  const free: Blob[] = [];
  for (const b of w.blobs) {
    if (!b.alive || b.faction !== f.id) continue;
    if (b.order.kind === 'befriend') current++;
    else if (b.order.kind === 'none' && b.role === 'citizen' && b.jail <= 0 && b.age >= ADULT_AGE && b.job !== 'student') free.push(b);
  }
  if (current >= want || free.length === 0) return;
  free.sort((a, b) => talkScore(b.traits) - talkScore(a.traits));
  const hall = w.hall(f.id);
  const hx = hall?.x ?? free[0].x;
  const hy = hall?.y ?? free[0].y;
  for (const amb of free.slice(0, want - current)) {
    let best: Blob | null = null;
    let bestScore = Infinity;
    for (const t of w.blobs) {
      if (!t.alive || t.faction === f.id || t.role === 'police' || t.jail > 0) continue;
      if (dist2(hx, hy, t.x, t.y) > 750 * 750) continue;
      const d = Math.sqrt(dist2(amb.x, amb.y, t.x, t.y));
      const score = d * (t.faction === 0 ? 1 : 1.6) * (0.5 + t.loyalty);
      if (score < bestScore) {
        bestScore = score;
        best = t;
      }
    }
    if (!best) return;
    amb.order = { kind: 'befriend', target: best.id, tries: 0 };
    amb.role = 'ambassador';
  }
}

function aiAggression(w: World, f: Faction): void {
  if (!w.rng.chance(f.ai!.aggression * w.mode.aiAggression * 0.35)) return;
  let attacker: Blob | null = null;
  let best = -Infinity;
  for (const b of w.blobs) {
    if (!b.alive || b.faction !== f.id || b.role !== 'citizen' || b.order.kind !== 'none' || b.jail > 0) continue;
    if (b.age < ADULT_AGE || b.heat > 0) continue;
    const s = b.traits.strength + b.traits.violence - b.traits.kindness;
    if (s > best) {
      best = s;
      attacker = b;
    }
  }
  if (!attacker) return;
  let target: Blob | null = null;
  let bd = 500 * 500;
  for (const t of w.blobs) {
    if (!t.alive || t.faction === f.id || t.role === 'police' || t.jail > 0) continue;
    const d = dist2(attacker.x, attacker.y, t.x, t.y);
    if (d < bd) {
      bd = d;
      target = t;
    }
  }
  if (target) attacker.order = { kind: 'attack', target: target.id, hits: 0 };
}

/** What a rival's schools teach, in the order it builds them. Teachers first: they spread everything else. */
const AI_FOCUS: readonly TraitKey[] = ['teaching', 'kindness', 'finance', 'science', 'honesty'];

/** Students per school, and how good one gets before going back to normal life. */
const AI_STUDENTS = 2;
const AI_GRADUATE = 0.65 * SKILL_MAX;

/** One teacher per school (plus one for friendly towns), a couple of students, and something for each school to teach. */
function aiJobs(w: World, f: Faction): void {
  let n = 0;
  for (const s of w.buildings) if (s.kind === 'school' && s.faction === f.id) s.focus = AI_FOCUS[n++ % AI_FOCUS.length];
  const want = f.counts.school + (f.ai!.diplomacy > 0.5 ? 1 : 0);
  let have = 0;
  let studying = 0;
  let best: Blob | null = null;
  let next: Blob | null = null;
  for (const b of w.blobs) {
    if (!b.alive || b.faction !== f.id) continue;
    if (b.job === 'student' && AI_FOCUS.some((k) => b.traits[k] >= AI_GRADUATE)) b.job = 'social';
    if (b.job === 'teacher') have++;
    else if (b.job === 'student') studying++;
    else if (b.role === 'citizen' && b.job === 'social' && b.age >= ADULT_AGE) {
      if (!best || b.traits.teaching > best.traits.teaching) best = b;
      if (!next || talkScore(b.traits) > talkScore(next.traits)) next = b;
    }
  }
  if (have < want && best) best.job = 'teacher';
  else if (studying < f.counts.school * AI_STUDENTS && next) next.job = 'student';
}

/** Pushy towns try to take over a rival's nearby building. */
function aiUsurp(w: World, f: Faction): void {
  if (!w.rng.chance(f.ai!.aggression * w.mode.aiAggression * 0.2)) return;
  const hall = w.hall(f.id);
  if (!hall) return;
  let target: Building | null = null;
  let bd = 900 * 900;
  for (const b of w.buildings) {
    if (b.faction === f.id || b.faction === 0 || b.kind === 'hall') continue;
    const d = dist2(hall.x, hall.y, b.x, b.y);
    if (d < bd) {
      bd = d;
      target = b;
    }
  }
  if (target) w.command({ type: 'autoUsurp', faction: f.id, building: target.id, count: 5 });
}
