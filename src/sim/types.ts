import type { TraitKey, Traits } from './traits';

export type Job = 'social' | 'teacher' | 'recruiter';

export type Role = 'citizen' | 'police' | 'ambassador';
export type Mood = 'calm' | 'happy' | 'angry' | 'scared' | 'sad';

export type Order =
  | { kind: 'none' }
  | { kind: 'move'; x: number; y: number }
  | { kind: 'befriend'; target: number; tries: number }
  /** Mentor a teammate: their traits move toward the teacher's wherever the teacher is better. */
  | { kind: 'teach'; target: number; tries: number; gain: Partial<Record<TraitKey, number>> }
  | { kind: 'attack'; target: number; hits: number }
  /** Peaceful takeover: stand at another team's building until it's yours. */
  | { kind: 'usurp'; building: number }
  | { kind: 'chase'; target: number }
  | { kind: 'flee'; fromX: number; fromY: number; time: number };

export interface Blob {
  id: number;
  name: string;
  faction: number;
  x: number;
  y: number;
  /** Position at the start of the tick, for render interpolation. */
  px: number;
  py: number;
  vx: number;
  vy: number;
  /** Wander target. */
  tx: number;
  ty: number;
  wanderTimer: number;
  homeX: number;
  homeY: number;
  /** Building this blob lives near (-1 = none yet). */
  home: number;
  /** Standing job the blob goes back to whenever it's idle. */
  job: Job;
  jobCd: number;
  /** Can't be picked by a job teacher again until this runs out. */
  lessonCd: number;
  /** Group befriend: keep befriending strangers in this area until it's empty or time runs out. */
  area: { x: number; y: number; r: number; until: number } | null;
  traits: Traits;
  /** Attachment to current faction. Hits 0 → converts to whoever is talking to them. */
  loyalty: number;
  health: number;
  age: number;
  lifespan: number;
  role: Role;
  order: Order;
  byPlayer: boolean;
  /** Seconds remaining on "wanted" status after violence. */
  heat: number;
  /** Seconds remaining in jail. */
  jail: number;
  /** Faction whose police made the arrest. */
  jailedBy: number;
  talkCd: number;
  attackCd: number;
  breedCd: number;
  /** Throttle for police / flee scans. */
  scanCd: number;
  /** Throttle for spontaneous-violence rolls. */
  urgeCd: number;
  stun: number;
  mood: Mood;
  moodTime: number;
  /** Id of blob last talked to, for eyes to look at. */
  lookAt: number;
  alive: boolean;
}

export type BuildingKind = 'hall' | 'house' | 'school' | 'lab' | 'market' | 'police' | 'fountain';

export interface Building {
  id: number;
  kind: BuildingKind;
  faction: number;
  x: number;
  y: number;
  /** Takeover progress 0..1 by `captureBy`. */
  capture: number;
  captureBy: number;
  /** School only: trait it teaches. */
  focus: TraitKey;
}

export interface AiPersonality {
  weights: Partial<Record<BuildingKind, number>>;
  aggression: number;
  diplomacy: number;
}

export interface FactionStats {
  converted: number;
  lost: number;
  births: number;
  deaths: number;
  attacks: number;
  arrests: number;
  kills: number;
  jailed: number;
  lessons: number;
  usurped: number;
}

export interface Faction {
  id: number;
  name: string;
  color: number;
  isPlayer: boolean;
  isNeutral: boolean;
  ai: AiPersonality | null;
  aiTimer: number;
  policeTimer: number;
  gold: number;
  research: number;
  tech: number;
  /** 0..1, multiplies how persuasive members are. Violence lowers it. */
  reputation: number;
  /** grudge[other] 0..1: how much this faction resents `other`. Lowers other's conversion pull. */
  grudge: number[];
  stats: FactionStats;
  // Cached each tick:
  pop: number;
  police: number;
  cap: number;
  counts: Record<BuildingKind, number>;
}

export type SimEventType =
  | 'talk'
  | 'teach'
  | 'taught'
  | 'usurp'
  | 'usurping'
  | 'convert'
  | 'fearConvert'
  | 'defect'
  | 'hit'
  | 'kill'
  | 'arrest'
  | 'escape'
  | 'release'
  | 'birth'
  | 'death'
  | 'build'
  | 'tech'
  | 'recruit'
  | 'notice';

export interface SimEvent {
  type: SimEventType;
  x: number;
  y: number;
  /** Faction the event mostly concerns (new faction for conversions, attacker for hits). */
  faction: number;
  /** Other faction involved (old faction, victim faction...), or -1. */
  other: number;
  blob: number;
  target: number;
  text: string;
  /** Player gave this order directly (vs. a job or AI). */
  manual?: boolean;
}

export type OrderCommand = 'move' | 'befriend' | 'attack' | 'teach' | 'usurp' | 'stop';

export type Command =
  | { type: 'order'; faction: number; ids: number[]; order: OrderCommand; x?: number; y?: number; target?: number; building?: number }
  | { type: 'build'; faction: number; kind: BuildingKind; x: number; y: number }
  | { type: 'autoBefriend'; faction: number; target: number; count?: number }
  | { type: 'befriendArea'; faction: number; ids: number[]; x: number; y: number; r: number; target?: number }
  | { type: 'job'; faction: number; ids: number[]; job: Job }
  | { type: 'autoUsurp'; faction: number; building: number; count: number }
  | { type: 'autoAttack'; faction: number; target: number }
  | { type: 'focus'; faction: number; building: number; trait: TraitKey }
  /** Gold from outside the sim (a rewarded ad). */
  | { type: 'gift'; faction: number; gold: number };
