import { ADULT_AGE, NEUTRAL, POLICE_RECRUIT_COST, policeDetectRadius, policeSkill } from '../config';
import type { Blob } from '../types';
import { clamp, dist2 } from '../util';
import type { World } from '../world';

const near: Blob[] = [];

/**
 * Police patrol their town and arrest anyone wanted for violence, from any
 * faction. Higher tech = wider detection, faster chase, surer catch.
 */
export function police(w: World, dt: number): void {
  recruit(w, dt);
  for (const p of w.blobs) {
    if (!p.alive || p.role !== 'police' || p.jail > 0 || p.stun > 0) continue;
    const f = w.factions[p.faction];
    const jr = w.territoryRadius(p.faction) + 60;
    const o = p.order;

    if (o.kind === 'chase') {
      const c = w.byId.get(o.target);
      if (!c || !c.alive || c.jail > 0 || c.heat <= 0) {
        w.endOrder(p);
        continue;
      }
      if (dist2(p.homeX, p.homeY, c.x, c.y) > (jr * 1.7) ** 2) {
        w.endOrder(p); // out of jurisdiction
        continue;
      }
      if (p.attackCd <= 0 && dist2(p.x, p.y, c.x, c.y) <= 26 * 26) {
        p.attackCd = 0.8;
        const chance = clamp(
          0.45 + 0.4 * policeSkill(f.tech) + 0.15 * p.traits.strength - 0.3 * c.traits.fitness - 0.1 * c.traits.strength,
          0.12,
          0.97,
        );
        if (w.rng.chance(chance)) {
          w.jail(c, p);
          w.endOrder(p);
        } else {
          p.stun = 0.6;
          w.emit('escape', c.x, c.y, { faction: c.faction, other: p.faction, blob: c.id, target: p.id, text: c.name });
        }
      }
      continue;
    }

    if (o.kind !== 'none' || p.scanCd > 0) continue;
    p.scanCd = 0.35;
    const detect = policeDetectRadius(f.tech);
    w.grid.query(p.x, p.y, detect, near);
    let best: Blob | null = null;
    let bd = Infinity;
    for (const c of near) {
      if (c === p || c.heat <= 0 || c.jail > 0) continue;
      if (dist2(p.homeX, p.homeY, c.x, c.y) > (jr + detect) ** 2) continue;
      const d = dist2(p.x, p.y, c.x, c.y);
      if (d < bd) {
        bd = d;
        best = c;
      }
    }
    if (best) {
      p.order = { kind: 'chase', target: best.id };
      p.mood = 'angry';
      p.moodTime = 1;
    }
  }
}

function recruit(w: World, dt: number): void {
  for (const f of w.factions) {
    if (f.id === NEUTRAL) continue;
    f.policeTimer -= dt;
    if (f.policeTimer > 0) continue;
    f.policeTimer = 1.5;
    const desired = (f.counts.hall > 0 ? 1 : 0) + 2 * f.counts.police + (f.tech >= 5 ? 1 : 0);
    if (f.police >= desired || f.gold < POLICE_RECRUIT_COST || f.pop < 4) continue;

    let best: Blob | null = null;
    let score = -Infinity;
    for (const b of w.blobs) {
      if (!b.alive || b.faction !== f.id || b.role !== 'citizen' || b.order.kind !== 'none') continue;
      if (b.jail > 0 || b.heat > 0 || b.age < ADULT_AGE) continue;
      const s = b.traits.honesty + 0.6 * b.traits.strength + 0.6 * b.traits.fitness - b.traits.violence;
      if (s > score) {
        score = s;
        best = b;
      }
    }
    if (!best) continue;
    f.gold -= POLICE_RECRUIT_COST;
    best.role = 'police';
    f.police++;
    const stations = w.buildings.filter((x) => x.faction === f.id && x.kind === 'police');
    const home = stations.length > 0 ? stations[f.police % stations.length] : w.hall(f.id);
    if (home) {
      best.homeX = home.x;
      best.homeY = home.y;
    }
    w.emit('recruit', best.x, best.y, { faction: f.id, blob: best.id, text: best.name });
  }
}
