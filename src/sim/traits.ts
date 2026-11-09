import type { Rng } from './rng';
import { clamp, clamp01 } from './util';

/** The best a skill can get, after a lifetime of focus. Players see it as 100. */
export const SKILL_MAX = 3;
/** About the best anyone gets without real training (33 to players). Blobs are born around 0.5 (17). */
export const NATURAL_MAX = 1;
/** How much of their parents' difference from an ordinary blob a child is born with. */
const HERITABLE = 0.4;

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

/** Child traits: a head start from great parents, but they still have to be trained themselves. */
export function inheritTraits(a: Traits, b: Traits, rng: Rng, mutation: number): Traits {
  const t = {} as Traits;
  for (const k of TRAIT_KEYS) t[k] = clamp(0.5 + ((a[k] + b[k]) / 2 - 0.5) * HERITABLE + rng.gauss() * mutation, 0, topOf(k));
  return t;
}

/**
 * Culture spreading through conversation. Chatting evens out what's ordinary, but it
 * never takes a blob past natural ability, and never wears down what one has trained.
 */
export function driftTraits(target: Traits, source: Traits, rate: number): void {
  for (const k of TRAIT_KEYS) {
    if (target[k] > NATURAL_MAX) continue;
    target[k] = clamp01(target[k] + (Math.min(source[k], NATURAL_MAX) - target[k]) * rate);
  }
}

const topOf = (k: TraitKey): number => (NEGATIVE_TRAITS.has(k) ? 1 : SKILL_MAX);

/** Training runs at full speed up to natural ability, then every step is harder than the last. */
export function trainingEase(v: number): number {
  if (v <= NATURAL_MAX) return 1;
  const left = 1 - (v - NATURAL_MAX) / (SKILL_MAX - NATURAL_MAX);
  return Math.max(0.06, left * left);
}

/** What a skill is worth: it grows much faster than the skill, so an expert is worth many beginners. */
export const payoff = (v: number): number => v * (0.3 + v);

/** Practice a skill. `amount` is what a beginner would gain. */
export function train(t: Traits, k: TraitKey, amount: number): void {
  t[k] = Math.min(topOf(k), t[k] + amount * trainingEase(t[k]));
}

/** A skill as players see it, 0..1 of the most it can be. */
export const skillShare = (k: TraitKey, v: number): number => v / topOf(k);

const GRADES: readonly [number, string][] = [
  [0.28, 'Mediocre'],
  [0.45, 'Decent'],
  [0.65, 'Good'],
  [0.85, 'Excellent'],
];

/** A word for a skill's share of its maximum. */
export function gradeOf(share: number): string {
  return GRADES.find(([under]) => share < under)?.[1] ?? 'Legendary';
}

/** How persuasive a blob is in conversation, on the same scale as a skill. */
export function talkScore(t: Traits): number {
  return 0.25 * t.teaching + 0.2 * t.kindness + 0.2 * t.honesty + 0.15 * t.intelligence + 0.1 * t.patience + 0.1 * t.openness;
}
