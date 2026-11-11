import type { ModeId } from './modes';
import { platform } from './platform';
import { ADULT_AGE, NEUTRAL } from './sim/config';
import type { Blob } from './sim/types';
import { dist2 } from './sim/util';
import type { World } from './sim/world';
import { say, type Pointer, type Text } from './tutorials';

/**
 * A new player's first real game: three steps, each pointed at on the map, until their
 * first new friend. Once that happens it never shows again.
 */
interface CoachStep {
  text: Text;
  sub: Text;
  label: Text;
}

const STEPS: readonly CoachStep[] = [
  {
    text: ['Tap one of your blue blobs', 'Click one of your blue blobs'],
    sub: ['Blue blobs are your team.', 'Blue blobs are your team. Drag a box to pick several.'],
    label: ['Tap me', 'Click me'],
  },
  {
    text: ['Now tap the grey strangers', 'Now right-click the grey strangers'],
    sub: 'Your blob walks over and chats with the crowd until they join you.',
    label: 'Strangers',
  },
  {
    text: 'Let them chat…',
    sub: 'Every chat loosens their old ties. Charming, kind, honest blobs win friends fastest.',
    label: 'Chatting',
  },
];

export interface CoachCard {
  icon: string;
  title: string;
  step: number;
  steps: number;
  text: string;
  sub: string;
  progress: null;
}

const KEY = 'mindblobs.coached.v1';
let coachedCache: boolean | null = null;

export function coached(): boolean {
  if (coachedCache === null) {
    try {
      coachedCache = platform.storage.getItem(KEY) === '1';
    } catch {
      coachedCache = false;
    }
  }
  return coachedCache;
}

export function markCoached(): void {
  coachedCache = true;
  platform.storage.setItem(KEY, '1');
}

export class Coach {
  /** The blob the first step points at, and the stranger the second one does. Kept while they suit. */
  private mine = -1;
  private stranger = -1;

  constructor(
    private readonly me: number,
    private readonly mode: ModeId,
  ) {}

  /** Worked out fresh each frame, so dropping your selection takes you back a step. */
  step(w: World, sel: readonly Blob[]): number {
    if (w.blobs.some((b) => b.alive && b.faction === this.me && b.order.kind === 'befriend')) return 2;
    return sel.length > 0 ? 1 : 0;
  }

  card(w: World, sel: readonly Blob[]): CoachCard {
    const n = this.step(w, sel);
    const s = STEPS[n];
    return { icon: '👋', title: 'First steps', step: n, steps: STEPS.length, text: say(s.text, this.mode), sub: say(s.sub, this.mode), progress: null };
  }

  points(w: World, sel: readonly Blob[]): Pointer[] {
    const n = this.step(w, sel);
    const label = say(STEPS[n].label, this.mode);
    const at = (b: Blob | undefined): Pointer[] => (b && b.alive ? [{ x: b.x, y: b.y - 18, label }] : []);
    if (n === 0) return at(this.pickMine(w));
    if (n === 1) return at(this.pickStranger(w, sel[0]));
    const busy = w.blobs.find((b) => b.alive && b.faction === this.me && b.order.kind === 'befriend');
    const target = busy && busy.order.kind === 'befriend' ? w.byId.get(busy.order.target) : undefined;
    return at(target);
  }

  /** A grown-up of yours near the town hall. */
  private pickMine(w: World): Blob | undefined {
    const kept = w.byId.get(this.mine);
    if (kept && kept.alive && w.commandable(kept, this.me) && kept.age >= ADULT_AGE) return kept;
    const hall = w.hall(this.me);
    if (!hall) return undefined;
    let best: Blob | undefined;
    for (const b of w.blobs) {
      if (!w.commandable(b, this.me) || b.age < ADULT_AGE) continue;
      if (!best || dist2(b.x, b.y, hall.x, hall.y) < dist2(best.x, best.y, hall.x, hall.y)) best = b;
    }
    this.mine = best?.id ?? -1;
    return best;
  }

  /** The wanderer nearest the blob you picked (or your town). */
  private pickStranger(w: World, from: Blob | undefined): Blob | undefined {
    const kept = w.byId.get(this.stranger);
    if (kept && kept.alive && kept.faction === NEUTRAL) return kept;
    const o = from ?? w.hall(this.me);
    if (!o) return undefined;
    let best: Blob | undefined;
    for (const b of w.blobs) {
      if (!b.alive || b.faction !== NEUTRAL) continue;
      if (!best || dist2(b.x, b.y, o.x, o.y) < dist2(best.x, best.y, o.x, o.y)) best = b;
    }
    this.stranger = best?.id ?? -1;
    return best;
  }
}
