import { ADULT_AGE, ATTACK_RANGE, NEUTRAL } from '../config';
import type { Blob } from '../types';
import { clamp01, dist2 } from '../util';
import type { World } from '../world';

const near: Blob[] = [];

/**
 * Violence is fast but costly: attackers become wanted, their faction's
 * reputation drops, victims' factions hold grudges, and kind teammates lose faith.
 */
export function violence(w: World, _dt: number): void {
  for (const b of w.blobs) {
    if (!b.alive || b.jail > 0 || b.stun > 0 || b.role === 'police') continue;

    // Spontaneous aggression from violent, unkind blobs.
    if (b.order.kind === 'none' && b.urgeCd <= 0 && b.age >= ADULT_AGE) {
      b.urgeCd = 1;
      const f = w.factions[b.faction];
      const bias = f.ai ? f.ai.aggression * 0.12 * w.mode.aiAggression : 0;
      const urge = b.traits.violence - 0.5 - 0.45 * b.traits.kindness + bias;
      if (urge > 0 && w.rng.chance(urge * 0.03)) {
        const t = nearestVictim(w, b, 140);
        if (t) {
          b.order = { kind: 'attack', target: t.id, hits: 0 };
          b.byPlayer = false;
        }
      }
    }

    const o = b.order;
    if (o.kind !== 'attack' || b.attackCd > 0) continue;
    const t = w.byId.get(o.target);
    if (!t || !t.alive || t.jail > 0) continue;
    if (dist2(b.x, b.y, t.x, t.y) > ATTACK_RANGE * ATTACK_RANGE) continue;
    hit(w, b, t);
    if (b.order === o) {
      o.hits++;
      if (o.hits >= 3 || !t.alive || t.faction === b.faction) w.endOrder(b);
    }
  }
}

export function nearestVictim(w: World, b: Blob, r: number): Blob | null {
  w.grid.query(b.x, b.y, r, near);
  let best: Blob | null = null;
  let bd = Infinity;
  for (const c of near) {
    if (c === b || c.faction === b.faction || c.jail > 0 || c.role === 'police') continue;
    const d = dist2(b.x, b.y, c.x, c.y);
    if (d < bd) {
      bd = d;
      best = c;
    }
  }
  return best;
}

export function hit(w: World, a: Blob, t: Blob): void {
  a.attackCd = 0.9;
  const dmg = Math.max(0.05, 0.18 + 0.3 * a.traits.strength - 0.12 * t.traits.fitness - 0.08 * t.traits.strength);
  t.health -= dmg;
  a.heat = t.role === 'police' ? 80 : 60;
  a.mood = 'angry';
  a.moodTime = 3;

  const fa = w.factions[a.faction];
  const ft = w.factions[t.faction];
  fa.stats.attacks++;
  fa.reputation = clamp01(fa.reputation - 0.025);
  ft.grudge[a.faction] = clamp01(ft.grudge[a.faction] + 0.12);
  if (!ft.isNeutral && !fa.isNeutral) {
    const loot = Math.min(ft.gold, 3 + 0.02 * ft.gold);
    ft.gold -= loot;
    fa.gold += loot;
  }
  witnesses(w, a, t);
  w.emit('hit', t.x, t.y, { faction: a.faction, other: t.faction, blob: a.id, target: t.id, text: a.name });

  if (t.health <= 0) {
    fa.stats.kills++;
    w.kill(t, 'violence', a);
    return;
  }

  if (t.role === 'police') {
    t.order = { kind: 'chase', target: a.id };
  } else if (t.order.kind !== 'attack') {
    w.endOrder(t);
    t.order = { kind: 'flee', fromX: a.x, fromY: a.y, time: 2.5 };
  }
  t.mood = 'scared';
  t.moodTime = 2.5;

  // Weak, disloyal victims sometimes give in out of fear. Such converts are flimsy.
  if (
    t.faction !== a.faction &&
    t.role === 'citizen' &&
    t.loyalty < 0.35 &&
    w.rng.chance((1 - t.traits.allegiance) * 0.25 * (1 - t.traits.strength))
  ) {
    w.convert(t, a.faction, 'fear');
  }
}

function witnesses(w: World, a: Blob, t: Blob): void {
  w.grid.query(t.x, t.y, 150, near);
  for (const o of near) {
    if (o === a || o === t || o.jail > 0) continue;
    if (o.faction === t.faction) {
      // Victim's friends rally together.
      o.loyalty = Math.min(w.loyaltyCap(o), o.loyalty + 0.03);
    } else if (o.faction === a.faction) {
      // Kind teammates are disgusted.
      o.loyalty -= 0.04 * o.traits.kindness;
      if (o.loyalty <= 0) w.convert(o, NEUTRAL, 'talk');
    } else {
      const fo = w.factions[o.faction];
      fo.grudge[a.faction] = clamp01(fo.grudge[a.faction] + 0.02);
    }
    if (o.role !== 'police' && o.mood !== 'angry') {
      o.mood = 'scared';
      o.moodTime = 1.2;
    }
  }
}
