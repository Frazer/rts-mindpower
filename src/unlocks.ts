import { platform } from './platform';

/**
 * Casual players start with the buttons that matter most (Befriend, Teach and Move) and meet
 * the rest a few at a time as they play. Once met, a button stays for every later game.
 * Pro and the tutorials show everything from the start.
 */
export type Feature = 'nearby' | 'stop' | 'usurp' | 'jobs' | 'attack';

/** What happens in a game that can bring the next buttons in. */
export interface UnlockCtx {
  /** Game seconds since the start. */
  time: number;
  /** You have won over at least one blob this game. */
  madeFriend: boolean;
  /** You have a school. */
  hasSchool: boolean;
}

export interface Unlock {
  features: readonly Feature[];
  /** Shown once, when they appear. */
  intro: string;
  ready(c: UnlockCtx): boolean;
}

/** In order: each one waits for the one before it. */
export const UNLOCKS: readonly Unlock[] = [
  {
    features: ['nearby', 'stop'],
    intro: '🆕 New buttons: 👥 Select nearby picks the blobs around one (or double-tap a blob), and ✋ Stop calls them back. A crowd makes friends faster!',
    ready: (c) => c.madeFriend || c.time >= 90,
  },
  {
    features: ['usurp'],
    intro: '🆕 🏳️ Take over: send your blobs to stand at a rival’s building. Outnumber the blobs there and it becomes yours.',
    ready: (c) => c.time >= 150,
  },
  {
    features: ['jobs'],
    intro: '🆕 Jobs: 🎓 Teacher, 🌸 Recruiter and 🎒 Student keep blobs busy on their own. Tap a blob to give it one.',
    ready: (c) => c.time >= 240 || c.hasSchool,
  },
  {
    features: ['attack'],
    intro: '🆕 💥 Bonk: quick, but police arrest attackers (even yours) and every team trusts you a little less.',
    ready: (c) => c.time >= 330,
  },
];

export const ALL_FEATURES: readonly Feature[] = UNLOCKS.flatMap((u) => u.features);

const KEY = 'mindblobs.unlocks.v1';

function read(): Set<Feature> {
  try {
    const raw = platform.storage.getItem(KEY);
    const list: unknown = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(list) ? list.filter((f): f is Feature => ALL_FEATURES.includes(f as Feature)) : []);
  } catch {
    // Junk saved: start fresh.
    return new Set();
  }
}

// Kept in memory too, so unlocks still work this session when storage is blocked.
let cache: Set<Feature> | null = null;
const get = (): Set<Feature> => (cache ??= read());

export function unlocked(): ReadonlySet<Feature> {
  return get();
}

/** The next group still to come, or null when you have everything. */
export function nextUnlock(): Unlock | null {
  const have = get();
  return UNLOCKS.find((u) => u.features.some((f) => !have.has(f))) ?? null;
}

export function unlock(features: readonly Feature[]): void {
  const have = get();
  if (features.every((f) => have.has(f))) return;
  for (const f of features) have.add(f);
  platform.storage.setItem(KEY, JSON.stringify([...have]));
}
