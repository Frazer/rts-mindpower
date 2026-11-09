import type { Blob, Building, BuildingKind, Faction } from './types';

export const DT = 1 / 20;
/** Ages are in blob-years: grown up at 12, most live to around 100. */
export const ADULT_AGE = 12;
/** Childhood passes this many times faster than the rest of life, so towns still grow. */
export const CHILD_GROWTH = 3;

/** Age a blob dies of old age. Getting fit adds years, so training it pays off for longer. */
export function lifeLength(b: Blob): number {
  return b.lifespan + 25 * Math.min(2, b.traits.fitness);
}
export const TALK_RANGE = 34;
export const ATTACK_RANGE = 26;
export const SCHOOL_RADIUS = 150;
export const MAX_TECH = 10;
export const PLAYER = 1;
export const NEUTRAL = 0;

export interface BuildingDef {
  cost: number;
  label: string;
  icon: string;
  radius: number;
  /** A few words for the build button. */
  short: string;
  desc: string;
  /** What each level adds. */
  nextLevel: string;
}

export const BUILDINGS: Record<BuildingKind, BuildingDef> = {
  hall: { cost: 0, label: 'Town Hall', icon: '🏛️', radius: 36, short: 'Room for 12', desc: 'Heart of your town. Room for 12.', nextLevel: '+6 room' },
  house: { cost: 40, label: 'House', icon: '🏠', radius: 22, short: '+5 babies', desc: 'Room for 5 more babies. Babies only come when your town has room.', nextLevel: '+5 room for babies' },
  school: { cost: 80, label: 'School', icon: '🏫', radius: 26, short: 'Teaches a trait', desc: 'Your blobs inside its circle slowly learn the trait you pick (kids learn twice as fast). Blobs near it also persuade better.', nextLevel: 'Teaches 25% faster, wider circle' },
  lab: { cost: 90, label: 'Lab', icon: '🔬', radius: 24, short: 'Faster tech', desc: '+35% research. Higher tech makes your police sharper and your blobs more persuasive.', nextLevel: '+35% research' },
  market: { cost: 70, label: 'Market', icon: '💰', radius: 24, short: '+25% gold', desc: '+25% gold income. Blobs with Financial Smarts earn the most.', nextLevel: '+25% gold' },
  fountain: { cost: 120, label: 'Friendship Fountain', icon: '⛲', radius: 24, short: 'Befriends visitors', desc: 'Strangers who come near are slowly befriended, and wanderers are drawn to it. Build it at the edge of your land.', nextLevel: 'Befriends 25% faster, wider circle' },
  police: { cost: 100, label: 'Police Station', icon: '🚓', radius: 26, short: '+2 officers', desc: '+2 officers who arrest anyone who turns violent on your land, even your own blobs.', nextLevel: '+2 officers' },
};

export const BUILD_MENU: readonly BuildingKind[] = ['house', 'school', 'lab', 'market', 'police', 'fountain'];

export const FOUNTAIN_RADIUS = 140;
/** How far around a building blobs must stand to help take it over. */
export const USURP_RADIUS = 70;
/** Attackers needed (more than defenders) before a takeover starts. */
export const USURP_MIN = 3;

export const HALL_CAP = 12;
export const HOUSE_CAP = 5;
/** Extra room per town hall level (a house level just adds another HOUSE_CAP). */
export const HALL_LEVEL_CAP = 6;
export const POLICE_RECRUIT_COST = 15;

/** Cumulative research needed to reach a tech level. */
export function techThreshold(level: number): number {
  return 100 * level * level;
}

/** Each extra building of a kind costs more (50% of base per house, 40% for others). */
export function buildCost(f: Faction, kind: BuildingKind): number {
  const step = kind === 'house' ? 0.5 : 0.4;
  return Math.round(BUILDINGS[kind].cost * (1 + step * f.counts[kind]));
}

/** Buildings can be paid up to this level. Each level is worth one more of that building, without needing room for it. */
export const MAX_LEVEL = 5;
/** Town halls are free, so they can't take their upgrade price from what they cost to build. */
const HALL_UPGRADE = 150;

/** The first level costs what building another one would, then the price doubles each time. */
export function upgradeCost(f: Faction, b: Building): number {
  const price = b.kind === 'hall' ? HALL_UPGRADE : buildCost(f, b.kind);
  return price * (1 << (b.level - 1));
}

const reach = (b: Building): number => 1 + 0.12 * (b.level - 1);
export const schoolRadius = (b: Building): number => SCHOOL_RADIUS * reach(b);
export const fountainRadius = (b: Building): number => FOUNTAIN_RADIUS * reach(b);
/** How much faster a levelled-up school teaches or fountain befriends. */
export const levelSpeed = (b: Building): number => 1 + 0.25 * (b.level - 1);

/** Police quality from tech level, 0.35 at tech 0 up to 1.0 at tech 10. */
export function policeSkill(tech: number): number {
  return 0.35 + 0.065 * tech;
}

export function policeDetectRadius(tech: number): number {
  return 130 + 25 * tech;
}
