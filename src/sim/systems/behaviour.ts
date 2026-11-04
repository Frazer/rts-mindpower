import { ADULT_AGE, ATTACK_RANGE, BUILDINGS, FOUNTAIN_RADIUS, NEUTRAL, TALK_RANGE } from '../config';
import type { Blob } from '../types';
import { clamp, clamp01, dist2 } from '../util';
import type { World } from '../world';

interface Goal {
  x: number;
  y: number;
  speed: number;
  /** Stop when this close. */
  stop: number;
}

const goal: Goal = { x: 0, y: 0, speed: 0, stop: 0 };
const near: Blob[] = [];

function setGoal(x: number, y: number, speed: number, stop: number): Goal {
  goal.x = x;
  goal.y = y;
  goal.speed = speed;
  goal.stop = stop;
  return goal;
}

export function baseSpeed(b: Blob): number {
  let s = 26 + 34 * b.traits.fitness;
  if (b.age < ADULT_AGE) s *= 0.8;
  if (b.age > b.lifespan * 0.85) s *= 0.7;
  return s;
}

/** Timers, healing, jail, then move every blob toward its current goal. */
export function behaviour(w: World, dt: number): void {
  for (const b of w.blobs) {
    if (!b.alive) continue;
    tickTimers(w, b, dt);
    if (b.jail > 0) {
      jailTick(w, b, dt);
      continue;
    }
    if (b.stun > 0) {
      b.stun -= dt;
      b.vx *= 0.8;
      b.vy *= 0.8;
      b.x = clamp(b.x + b.vx * dt, 20, w.w - 20);
      b.y = clamp(b.y + b.vy * dt, 20, w.h - 20);
      continue;
    }
    steer(w, b, resolveGoal(w, b, dt), dt);
  }
}

function tickTimers(w: World, b: Blob, dt: number): void {
  b.talkCd -= dt;
  b.attackCd -= dt;
  b.breedCd -= dt;
  b.scanCd -= dt;
  b.urgeCd -= dt;
  b.wanderTimer -= dt;
  if (b.heat > 0) b.heat = Math.max(0, b.heat - dt);
  if (b.moodTime > 0) {
    b.moodTime -= dt;
    if (b.moodTime <= 0) b.mood = 'calm';
  }
  if (b.health < 1) b.health = Math.min(1, b.health + dt * (0.01 + 0.02 * b.traits.fitness));
  // Feeling at home slowly restores loyalty.
  const cap = w.loyaltyCap(b);
  if (b.loyalty < cap && dist2(b.x, b.y, b.homeX, b.homeY) < 250 * 250) {
    b.loyalty = Math.min(cap, b.loyalty + dt * 0.006 * (0.5 + b.traits.allegiance));
  }
}

function jailTick(w: World, b: Blob, dt: number): void {
  b.jail -= dt;
  b.vx = 0;
  b.vy = 0;
  // Rehabilitation: better societies reform prisoners faster.
  const tech = b.jailedBy >= 0 ? w.factions[b.jailedBy].tech : 0;
  const rate = dt * 0.004 * (1 + 0.15 * tech);
  b.traits.violence = clamp01(b.traits.violence - rate);
  b.traits.kindness = clamp01(b.traits.kindness + rate * 0.5);
  b.traits.honesty = clamp01(b.traits.honesty + rate * 0.3);
  if (b.jail <= 0) {
    b.jail = 0;
    b.mood = 'calm';
    b.wanderTimer = 0;
    w.emit('release', b.x, b.y, { faction: b.faction, other: b.jailedBy, blob: b.id, text: b.name });
  }
}

function resolveGoal(w: World, b: Blob, dt: number): Goal {
  const base = baseSpeed(b);
  const o = b.order;
  switch (o.kind) {
    case 'move':
      if (dist2(b.x, b.y, o.x, o.y) < 100) {
        w.endOrder(b);
        break;
      }
      return setGoal(o.x, o.y, base, 4);
    case 'befriend': {
      const t = w.byId.get(o.target);
      if (!t || !t.alive || t.jail > 0 || t.faction === b.faction) {
        w.endOrder(b);
        break;
      }
      return setGoal(t.x, t.y, base, TALK_RANGE * 0.7);
    }
    case 'teach': {
      const t = w.byId.get(o.target);
      if (!t || !t.alive || t.jail > 0 || t.faction !== b.faction) {
        w.endOrder(b);
        break;
      }
      return setGoal(t.x, t.y, base, TALK_RANGE * 0.7);
    }
    case 'attack': {
      const t = w.byId.get(o.target);
      if (!t || !t.alive || t.jail > 0 || t.faction === b.faction) {
        w.endOrder(b);
        break;
      }
      return setGoal(t.x, t.y, base * 1.1, ATTACK_RANGE * 0.6);
    }
    case 'usurp': {
      const bld = w.buildings.find((x) => x.id === o.building);
      if (!bld || bld.faction === b.faction) {
        w.endOrder(b);
        break;
      }
      // Stand in a ring around the building.
      const a = (b.id * 2.39996) % (Math.PI * 2);
      const r = BUILDINGS[bld.kind].radius + 22 + (b.id % 3) * 12;
      return setGoal(bld.x + Math.cos(a) * r, bld.y + 10 + Math.sin(a) * r * 0.7, base, 5);
    }
    case 'chase': {
      const t = w.byId.get(o.target);
      if (!t || !t.alive || t.jail > 0) {
        w.endOrder(b);
        break;
      }
      const tech = w.factions[b.faction].tech;
      return setGoal(t.x, t.y, base * 1.4 * (1 + 0.05 * tech), 6);
    }
    case 'flee': {
      o.time -= dt;
      if (o.time <= 0) {
        w.endOrder(b);
        break;
      }
      const dx = b.x - o.fromX;
      const dy = b.y - o.fromY;
      const d = Math.hypot(dx, dy) || 1;
      return setGoal(b.x + (dx / d) * 80, b.y + (dy / d) * 80, base * 1.15, 0);
    }
    case 'none':
      break;
  }

  // Wanted blobs run from police they can see.
  if (b.heat > 0 && b.role !== 'police' && b.scanCd <= 0) {
    b.scanCd = 0.4;
    const cop = nearestPolice(w, b, 130);
    if (cop) {
      b.order = { kind: 'flee', fromX: cop.x, fromY: cop.y, time: 1.5 };
      b.mood = 'scared';
      b.moodTime = 1.5;
      return setGoal(b.x + (b.x - cop.x), b.y + (b.y - cop.y), base * 1.15, 0);
    }
  }

  // Wander around home (citizens stay near their own building, police patrol the town).
  if (b.wanderTimer <= 0) {
    b.wanderTimer = w.rng.range(3, 8);
    const lure = b.faction === NEUTRAL && w.rng.chance(0.3) ? nearestFountain(w, b) : null;
    if (lure) {
      b.tx = clamp(lure.x + w.rng.range(-70, 70), 30, w.w - 30);
      b.ty = clamp(lure.y + w.rng.range(-50, 70), 30, w.h - 30);
    } else if (b.role !== 'police' && w.rng.chance(0.3)) {
      b.tx = b.x;
      b.ty = b.y;
    } else {
      const r =
        b.faction === NEUTRAL ? 170 : b.role === 'police' ? w.territoryRadius(b.faction) * 0.9 : b.age < ADULT_AGE ? 60 : 90;
      const a = w.rng.range(0, Math.PI * 2);
      const rr = Math.sqrt(w.rng.next()) * r;
      b.tx = clamp(b.homeX + Math.cos(a) * rr, 30, w.w - 30);
      b.ty = clamp(b.homeY + Math.sin(a) * rr, 30, w.h - 30);
    }
  }
  return setGoal(b.tx, b.ty, base * (b.role === 'police' ? 0.7 : 0.5), 3);
}

/** Friendship fountains draw in wanderers from a distance. */
function nearestFountain(w: World, b: Blob): { x: number; y: number } | null {
  let best: { x: number; y: number } | null = null;
  let bd = (FOUNTAIN_RADIUS + 360) ** 2;
  for (const f of w.buildings) {
    if (f.kind !== 'fountain') continue;
    const d = dist2(b.x, b.y, f.x, f.y);
    if (d < bd) {
      bd = d;
      best = f;
    }
  }
  return best;
}

function nearestPolice(w: World, b: Blob, r: number): Blob | null {
  w.grid.query(b.x, b.y, r, near);
  let best: Blob | null = null;
  let bd = Infinity;
  for (const c of near) {
    if (c.role !== 'police' || c.jail > 0) continue;
    const d = dist2(b.x, b.y, c.x, c.y);
    if (d < bd) {
      bd = d;
      best = c;
    }
  }
  return best;
}

function steer(w: World, b: Blob, g: Goal, dt: number): void {
  const dx = g.x - b.x;
  const dy = g.y - b.y;
  const d = Math.hypot(dx, dy);
  let desX = 0;
  let desY = 0;
  if (d > g.stop + 1) {
    const sp = g.speed * Math.min(1, (d - g.stop) / 25 + 0.2);
    desX = (dx / d) * sp;
    desY = (dy / d) * sp;
  }
  // Soft separation so blobs don't stack.
  w.grid.query(b.x, b.y, 24, near);
  for (const o of near) {
    if (o === b || o.jail > 0) continue;
    const ox = b.x - o.x;
    const oy = b.y - o.y;
    const dd = ox * ox + oy * oy;
    if (dd < 0.01) {
      desX += w.rng.range(-20, 20);
      continue;
    }
    const dist = Math.sqrt(dd);
    const push = ((24 - dist) / 24) * 40;
    desX += (ox / dist) * push;
    desY += (oy / dist) * push;
  }
  const k = Math.min(1, dt * 6);
  b.vx += (desX - b.vx) * k;
  b.vy += (desY - b.vy) * k;
  b.x = clamp(b.x + b.vx * dt, 20, w.w - 20);
  b.y = clamp(b.y + b.vy * dt, 20, w.h - 20);
}
