import { BUILDINGS, FOUNTAIN_RADIUS, NEUTRAL, USURP_MIN, USURP_RADIUS } from '../config';
import type { Blob } from '../types';
import { clamp01 } from '../util';
import type { World } from '../world';

const near: Blob[] = [];
const STEP = 0.5;

/** Friendship fountains befriend visitors; crowds standing at a rival's building take it over. */
export function towns(w: World, dt: number): void {
  w.townTimer -= dt;
  if (w.townTimer > 0) return;
  w.townTimer = STEP;
  fountains(w);
  usurping(w);
}

function fountains(w: World): void {
  for (const f of w.buildings) {
    if (f.kind !== 'fountain' || f.faction === NEUTRAL) continue;
    const owner = w.factions[f.faction];
    w.grid.query(f.x, f.y, FOUNTAIN_RADIUS, near);
    for (const b of near) {
      if (b.faction === f.faction || b.role === 'police' || b.jail > 0 || !b.alive) continue;
      const grudge = w.factions[b.faction].grudge[f.faction] ?? 0;
      const pull = 0.02 * (0.5 + owner.reputation) * (1 + 0.05 * owner.tech) * w.mode.conversionMult * (1 - 0.75 * grudge);
      const receptivity = 0.35 + 0.65 * b.traits.openness;
      b.loyalty -= pull * receptivity * STEP * 2;
      if (b.loyalty <= 0) {
        w.convert(b, f.faction, 'talk');
      } else if (w.rng.chance(0.15)) {
        w.emit('talk', b.x, b.y - 6, { faction: f.faction, other: b.faction, blob: b.id, target: b.id });
      }
    }
  }
}

function usurping(w: World): void {
  const n = w.factions.length;
  const power = new Array<number>(n);
  for (const bld of w.buildings) {
    if (bld.faction === NEUTRAL) continue;
    power.fill(0);
    w.grid.query(bld.x, bld.y, USURP_RADIUS + BUILDINGS[bld.kind].radius, near);
    for (const b of near) {
      if (!b.alive || b.jail > 0) continue;
      if (b.faction === bld.faction) {
        // Anyone at home defends; police count double.
        power[b.faction] += b.role === 'police' ? 2 : 1;
      } else if (b.order.kind === 'usurp' && b.order.building === bld.id) {
        power[b.faction] += 1;
      }
    }
    const def = power[bld.faction];
    let att = -1;
    for (let i = 0; i < n; i++) if (i !== bld.faction && (att < 0 || power[i] > power[att])) att = i;
    const net = att >= 0 ? power[att] - def : 0;
    if (att >= 0 && power[att] >= USURP_MIN && net > 0) {
      if (bld.captureBy !== att) {
        bld.captureBy = att;
        bld.capture = 0;
        w.emit('usurping', bld.x, bld.y, { faction: att, other: bld.faction, target: bld.id, text: BUILDINGS[bld.kind].label });
      }
      // Bigger crowds are faster; town halls hold out much longer.
      const rate = 0.025 * Math.min(net, 8) * (bld.kind === 'hall' ? 0.3 : 1);
      bld.capture = clamp01(bld.capture + rate * STEP);
      if (bld.capture >= 1) w.usurp(bld, att);
    } else if (bld.capture > 0) {
      bld.capture = Math.max(0, bld.capture - 0.05 * STEP);
      if (bld.capture === 0) bld.captureBy = -1;
    }
  }
}
