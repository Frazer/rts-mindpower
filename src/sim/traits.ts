import type { Rng } from './rng';
import { clamp01 } from './util';

export const TRAITS = [
  { key: 'intelligence', label: 'Intelligence', icon: '🧠', adj: 'Clever', effect: 'Faster research, a bit more persuasive' },
  { key: 'patience', label: 'Patience', icon: '⏳', adj: 'Patient', effect: 'Learns faster from teachers, chats more often' },
  { key: 'teaching', label: 'Teaching', icon: '📚', adj: 'Great teacher', effect: 'Best for teaching teammates and persuading strangers' },
  { key: 'science', label: 'Science & Math', icon: '🔬', adj: 'Science whiz', effect: 'Faster research, so higher tech' },
  { key: 'allegiance', label: 'Allegiance', icon: '🛡️', adj: 'Loyal', effect: 'Stays loyal, hard for rivals to win over' },
  { key: 'fitness', label: 'Fitness', icon: '🏃', adj: 'Speedy', effect: 'Faster, lives longer, escapes or catches' },
  { key: 'strength', label: 'Strength', icon: '💪', adj: 'Strong', effect: 'Hits harder, makes good police' },
  { key: 'fertility', label: 'Reproduction', icon: '🍼', adj: 'Family-minded', effect: 'More babies (needs room from houses)' },
  { key: 'violence', label: 'Violence', icon: '😠', adj: 'Hot-headed', effect: 'Picks fights, and police arrest them' },
  { key: 'kindness', label: 'Kindness', icon: '💗', adj: 'Kind', effect: 'Persuades well, keeps teammates loyal, avoids fights' },
  { key: 'openness', label: 'Openness to Strangers', icon: '👋', adj: 'Friendly to strangers', effect: 'Picks up traits in chats, but easier for rivals to win over' },
  { key: 'honesty', label: 'Honesty & Virtue', icon: '😇', adj: 'Honest', effect: 'Persuades well, makes good police' },
  { key: 'finance', label: 'Financial Smarts', icon: '💰', adj: 'Money-wise', effect: 'Earns more gold' },
] as const;

export type TraitKey = (typeof TRAITS)[number]['key'];
export type Traits = Record<TraitKey, number>;
export type TraitBias = Partial<Traits>;

export const TRAIT_KEYS: readonly TraitKey[] = TRAITS.map((t) => t.key);
export const TRAIT_INFO = Object.fromEntries(TRAITS.map((t) => [t.key, t])) as Record<
  TraitKey,
  (typeof TRAITS)[number]
>;

/** Traits where a high value is a problem, not a strength. */
export const NEGATIVE_TRAITS: ReadonlySet<TraitKey> = new Set<TraitKey>(['violence']);

export function randomTraits(rng: Rng, bias: TraitBias = {}): Traits {
  const t = {} as Traits;
  for (const k of TRAIT_KEYS) t[k] = clamp01(0.5 + (bias[k] ?? 0) + rng.gauss() * 0.16);
  return t;
}

/** Child traits: average of parents plus mutation. */
export function inheritTraits(a: Traits, b: Traits, rng: Rng, mutation: number): Traits {
  const t = {} as Traits;
  for (const k of TRAIT_KEYS) t[k] = clamp01((a[k] + b[k]) / 2 + rng.gauss() * mutation);
  return t;
}

/** Pull `target` traits toward `source` traits (culture spreading through conversation). */
export function driftTraits(target: Traits, source: Traits, rate: number): void {
  for (const k of TRAIT_KEYS) target[k] = clamp01(target[k] + (source[k] - target[k]) * rate);
}

/** How persuasive a blob is in conversation, 0..1. */
export function talkScore(t: Traits): number {
  return 0.25 * t.teaching + 0.2 * t.kindness + 0.2 * t.honesty + 0.15 * t.intelligence + 0.1 * t.patience + 0.1 * t.openness;
}
