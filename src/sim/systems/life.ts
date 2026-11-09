import { ADULT_AGE, CHILD_GROWTH, lifeLength } from '../config';
import { inheritTraits } from '../traits';
import type { Blob, Order } from '../types';
import type { World } from '../world';

const near: Blob[] = [];

/** Fighting or running blobs don't stop to start a family. */
const CAN_BREED: Record<Order['kind'], boolean> = {
  none: true,
  move: true,
  befriend: true,
  teach: true,
  usurp: true,
  attack: false,
  chase: false,
  flee: false,
};
const BUSY_BREEDING = 0.3;

/** Ageing, old-age death, and babies (limited by housing). */
export function life(w: World, dt: number): void {
  for (const b of w.blobs) {
    if (!b.alive) continue;
    b.age += dt * w.mode.yearsPerSecond * (b.age < ADULT_AGE ? CHILD_GROWTH : 1);
    if (b.age >= lifeLength(b)) {
      w.kill(b, 'old');
      continue;
    }
    if (b.age < ADULT_AGE || b.breedCd > 0 || b.jail > 0 || b.role === 'police' || !CAN_BREED[b.order.kind]) continue;
    b.breedCd = 2;
    const f = w.factions[b.faction];
    if (f.pop >= f.cap) continue;
    // Busy blobs (befriending, teaching, recruiting...) have far fewer babies than social ones.
    const busy = b.order.kind !== 'none' || b.job === 'student' ? BUSY_BREEDING : 1;
    const p = b.traits.fertility * Math.sqrt(b.traits.fertility) * 0.07 * (f.isNeutral ? 0.6 : 1) * busy;
    if (!w.rng.chance(p)) continue;

    w.grid.query(b.x, b.y, 60, near);
    let mate: Blob | null = null;
    for (const c of near) {
      if (c !== b && c.faction === b.faction && c.age >= ADULT_AGE && c.breedCd <= 2 && c.jail <= 0 && c.role !== 'police' && CAN_BREED[c.order.kind]) {
        mate = c;
        break;
      }
    }
    if (!mate) continue;
    const child = w.spawnBlob(
      b.faction,
      (b.x + mate.x) / 2,
      (b.y + mate.y) / 2 + 8,
      inheritTraits(b.traits, mate.traits, w.rng, 0.09),
      0,
      b.homeX,
      b.homeY,
    );
    child.home = b.home;
    child.loyalty = Math.min(w.loyaltyCap(child), child.loyalty + 0.15);
    b.breedCd = w.rng.range(30, 55);
    mate.breedCd = w.rng.range(30, 55);
    f.pop++;
    f.stats.births++;
    w.emit('birth', child.x, child.y, { faction: b.faction, blob: child.id, text: child.name });
  }
}
