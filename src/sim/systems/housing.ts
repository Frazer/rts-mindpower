import { NEUTRAL } from '../config';
import type { Blob, Building, BuildingKind } from '../types';
import { dist2 } from '../util';
import type { World } from '../world';

/** How many blobs each kind of building is "home" to. Spreads a town out over all its buildings. */
const HOME_CAP: Record<BuildingKind, number> = { hall: 10, house: 5, school: 4, lab: 3, market: 3, fountain: 2, police: 1 };
const MOVES_PER_PASS = 6;
/** A levelled-up building is home to more blobs, the same as if there were more of it. */
const homeCap = (h: Building): number => HOME_CAP[h.kind] * h.level;

const homes = new Map<number, Building>();
const counts = new Map<number, number>();

/**
 * Give every citizen a home building, so towns spread out instead of piling
 * up on the town hall. Runs once a second and rebalances a few blobs at a time
 * so they visibly stroll over to new buildings.
 */
export function housing(w: World, dt: number): void {
  w.housingTimer -= dt;
  if (w.housingTimer > 0) return;
  w.housingTimer = 1;

  homes.clear();
  counts.clear();
  for (const b of w.buildings) {
    if (b.faction === NEUTRAL) continue;
    homes.set(b.id, b);
    counts.set(b.id, 0);
  }
  const homeless: Blob[] = [];
  for (const b of w.blobs) {
    if (!b.alive || b.faction === NEUTRAL || b.role === 'police') continue;
    const h = homes.get(b.home);
    if (h && h.faction === b.faction) counts.set(h.id, counts.get(h.id)! + 1);
    else homeless.push(b);
  }
  for (const b of homeless) moveIn(w, b, emptiest(b.faction, b.x, b.y));

  // Rebalance: move a few blobs out of the most crowded homes.
  for (const f of w.factions) {
    if (f.isNeutral) continue;
    for (let m = 0; m < MOVES_PER_PASS; m++) {
      let worst: Building | null = null;
      let worstFill = 0;
      for (const h of homes.values()) {
        if (h.faction !== f.id) continue;
        const fill = counts.get(h.id)! / homeCap(h);
        if (fill > worstFill) {
          worstFill = fill;
          worst = h;
        }
      }
      const best = emptiest(f.id, worst?.x ?? 0, worst?.y ?? 0);
      if (!worst || !best || best === worst) break;
      const bestFill = (counts.get(best.id)! + 1) / homeCap(best);
      if (worstFill - bestFill < 0.5) break;
      const mover = w.blobs.find((b) => b.alive && b.home === worst!.id && b.role !== 'police' && b.order.kind === 'none');
      if (!mover) break;
      counts.set(worst.id, counts.get(worst.id)! - 1);
      moveIn(w, mover, best);
    }
  }
}

function emptiest(faction: number, x: number, y: number): Building | null {
  let best: Building | null = null;
  let bestScore = Infinity;
  for (const h of homes.values()) {
    if (h.faction !== faction) continue;
    // Fill ratio first; distance only breaks near-ties.
    const score = (counts.get(h.id)! + 1) / homeCap(h) + Math.sqrt(dist2(h.x, h.y, x, y)) / 4000;
    if (score < bestScore) {
      bestScore = score;
      best = h;
    }
  }
  return best;
}

function moveIn(w: World, b: Blob, h: Building | null): void {
  if (!h) return;
  b.home = h.id;
  b.homeX = h.x + w.rng.range(-35, 35);
  b.homeY = h.y + 28 + w.rng.range(-10, 30);
  b.wanderTimer = Math.min(b.wanderTimer, w.rng.range(0, 2));
  counts.set(h.id, (counts.get(h.id) ?? 0) + 1);
}
