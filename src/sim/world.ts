import type { ModeConfig } from '../modes';
import { BUILDINGS, HALL_CAP, HALL_LEVEL_CAP, HOUSE_CAP, MAX_LEVEL, NEUTRAL, ADULT_AGE, PLAYER, buildCost, schoolRadius, upgradeCost } from './config';
import { Grid } from './grid';
import { OBSTACLE_PAD, SIZES, type MapId, type MapSize, type Obstacle } from './maps';
import { blobName } from './names';
import { Rng } from './rng';
import { randomTraits, talkScore, type TraitBias, type Traits } from './traits';
import type {
  AiPersonality,
  Blob,
  Building,
  BuildingKind,
  Command,
  Faction,
  SimEvent,
  SimEventType,
} from './types';
import { clamp, clamp01, cos, dist2, sin } from './util';
import { behaviour } from './systems/behaviour';
import { social } from './systems/social';
import { violence } from './systems/violence';
import { police } from './systems/police';
import { life } from './systems/life';
import { economy } from './systems/economy';
import { ai } from './systems/ai';
import { housing } from './systems/housing';
import { isStranger, jobs } from './systems/jobs';
import { towns } from './systems/towns';

interface FactionDef {
  name: string;
  color: number;
  neutral?: boolean;
  player?: boolean;
  ai?: AiPersonality;
  bias: TraitBias;
  /** Start position as a fraction of world size. */
  pos: [number, number];
}

type TeamDef = Omit<FactionDef, 'pos'>;

const WANDERERS: TeamDef = { name: 'Wanderers', color: 0xc9c2d6, neutral: true, bias: {} };
const BLUE: TeamDef = {
  name: 'Blue Blobs',
  color: 0x4fa8ff,
  player: true,
  // Only used when an online game gives this team to the computer.
  ai: { weights: { house: 2, school: 2, lab: 2, market: 2, police: 1, fountain: 1 }, aggression: 0.4, diplomacy: 0.7 },
  bias: { kindness: 0.05, teaching: 0.05 },
};

/** AI teams, in the order they join as you add rivals. */
const RIVAL_DEFS: readonly TeamDef[] = [
  {
    name: 'Peachy Pals',
    color: 0xff7eb6,
    ai: { weights: { school: 3, house: 2, lab: 2, market: 2, police: 1, fountain: 2 }, aggression: 0.1, diplomacy: 1 },
    bias: { kindness: 0.15, openness: 0.1, teaching: 0.1, violence: -0.15 },
  },
  {
    name: 'Grumble Gang',
    color: 0xffa43a,
    ai: { weights: { house: 3, market: 2, police: 1, lab: 1, school: 1 }, aggression: 0.9, diplomacy: 0.4 },
    bias: { strength: 0.15, violence: 0.22, kindness: -0.15, fertility: 0.1, honesty: -0.1 },
  },
  {
    name: 'Minty Minds',
    color: 0x2fb86b,
    ai: { weights: { lab: 3, school: 2, house: 2, market: 2, police: 1, fountain: 1 }, aggression: 0.3, diplomacy: 0.7 },
    bias: { science: 0.15, intelligence: 0.12, patience: 0.06 },
  },
  {
    name: 'Cocoa Crew',
    color: 0xa0683f,
    ai: { weights: { house: 3, police: 2, market: 1, lab: 1, school: 1 }, aggression: 1, diplomacy: 0.3 },
    bias: { strength: 0.18, fitness: 0.12, violence: 0.2, patience: -0.12 },
  },
  {
    name: 'Lemon Drops',
    color: 0xffd23f,
    ai: { weights: { market: 3, house: 2, fountain: 2, school: 1, lab: 1, police: 1 }, aggression: 0.25, diplomacy: 0.9 },
    bias: { finance: 0.15, openness: 0.12, kindness: 0.08 },
  },
  {
    name: 'Plum Plotters',
    color: 0x9d6bff,
    ai: { weights: { house: 2, market: 2, lab: 2, police: 2, school: 1 }, aggression: 0.6, diplomacy: 0.6 },
    bias: { intelligence: 0.1, allegiance: 0.15, honesty: -0.12 },
  },
];

export const DEFAULT_RIVALS = 2;
export const MAX_RIVALS = RIVAL_DEFS.length;

/** The classic three-town map. */
const CLASSIC_POS: readonly [number, number][] = [
  [0.2, 0.74],
  [0.8, 0.7],
  [0.5, 0.22],
];

/**
 * Teams for a game: wanderers, you, then `rivals` AI teams. Two rivals keep the classic
 * layout; any other count spaces the towns evenly round the map, starting bottom-left.
 */
export function teamDefs(rivals = DEFAULT_RIVALS): FactionDef[] {
  const teams = [BLUE, ...RIVAL_DEFS.slice(0, clampRivals(rivals))];
  const n = teams.length;
  // Bottom-left, where you start on the classic map.
  const start = 2.4669;
  const pos = (i: number): [number, number] =>
    n === 3 ? CLASSIC_POS[i] : [0.5 + 0.36 * cos(start + (i * 2 * Math.PI) / n), 0.5 + 0.33 * sin(start + (i * 2 * Math.PI) / n)];
  return [{ ...WANDERERS, pos: [0.5, 0.5] }, ...teams.map((t, i) => ({ ...t, pos: pos(i) }))];
}

export function clampRivals(n: number): number {
  return Math.max(1, Math.min(MAX_RIVALS, Math.round(n) || DEFAULT_RIVALS));
}

/** Area grows with the number of towns, so each still has about as much room as on the classic map. */
const roomFor = (rivals: number): number => (clampRivals(rivals) + 1) / 3;

const emptyCounts = (): Record<BuildingKind, number> => ({ hall: 0, house: 0, school: 0, lab: 0, market: 0, police: 0, fountain: 0 });

/** Lets a tutorial build its own small map instead of the normal one. */
export interface WorldOptions {
  /** Places blobs and buildings by hand. Factions are still created as usual. */
  scenario?: (w: World) => void;
  /** Map size in pixels (defaults to the mode's). */
  size?: readonly [number, number];
  /** Rival teams think and build (default true). */
  ai?: boolean;
  /** Check for a winner (default true). */
  victory?: boolean;
  /** AI teams on the normal map (default 2). */
  rivals?: number;
  /** Teams people play (default just PLAYER). The rest are run by the computer. */
  humans?: readonly number[];
  /** Online: players' names for their teams. */
  names?: Readonly<Record<number, string>>;
  /** Layout of the normal map (default meadow: open grass). */
  map?: MapId;
  mapSize?: MapSize;
}

/** Each team's totals as the game went on, for the charts at the end. */
export interface History {
  /** Game seconds between rows. When a game runs long this doubles and every other row goes, so it stays small. */
  every: number;
  /** Each row is the time, then HISTORY_FIELDS numbers per team (team 0, the wild blobs, first). */
  rows: number[][];
}

/** Per team in each history row: blobs, gold earned so far, total building levels, tech level. */
export const HISTORY_FIELDS = 4;
const HISTORY_EVERY = 5;
const HISTORY_ROWS = 240;

/** Everything a running game needs to carry on, for catching up a player who fell out of step. */
interface Snapshot {
  time: number;
  blobs: Blob[];
  buildings: Building[];
  factions: Faction[];
  rng: number;
  nextId: number;
  victoryTimer: number;
  housingTimer: number;
  townTimer: number;
  neutralCap: number;
  outcome: Outcome | null;
  history: History;
}

// JSON can't hold -0, Infinity or NaN; tag them so a snapshot loads back bit for bit.
const ODD = '~n';
const saveNum = (_k: string, v: unknown): unknown =>
  typeof v === 'number' && (!Number.isFinite(v) || Object.is(v, -0)) ? { [ODD]: Object.is(v, -0) ? '-0' : String(v) } : v;
const loadNum = (_k: string, v: unknown): unknown =>
  v && typeof v === 'object' && ODD in v ? Number((v as Record<string, string>)[ODD]) : v;

/** FNV-1a over the exact bits of numbers and the characters of strings. */
class Hasher {
  h = 0x811c9dc5;
  private readonly view = new DataView(new ArrayBuffer(8));
  private mix(x: number): void {
    this.h = Math.imul(this.h ^ x, 0x01000193) >>> 0;
  }
  num(v: number): void {
    this.view.setFloat64(0, v);
    this.mix(this.view.getUint32(0));
    this.mix(this.view.getUint32(4));
  }
  str(s: string): void {
    for (let i = 0; i < s.length; i++) this.mix(s.charCodeAt(i));
  }
}

export interface Outcome {
  winner: number;
  reason: string;
  /** Percent of the world the winner leads, when that's how they won. */
  share?: number;
}

export class World {
  readonly rng: Rng;
  readonly w: number;
  readonly h: number;
  readonly grid: Grid;
  time = 0;
  blobs: Blob[] = [];
  readonly byId = new Map<number, Blob>();
  buildings: Building[] = [];
  factions: Faction[] = [];
  /** Bumped whenever buildings change so the renderer can redraw territory. */
  buildingsVersion = 0;
  neutralCap = 0;
  outcome: Outcome | null = null;
  history: History = { every: HISTORY_EVERY, rows: [] };
  private events: SimEvent[] = [];
  private cmds: Command[] = [];
  private nextId = 1;
  private victoryTimer = 0;
  housingTimer = 0;
  townTimer = 0;

  readonly aiOn: boolean;
  readonly victoryOn: boolean;
  readonly map: MapId;
  /** Ponds, rocks and trees: blobs go round them, nobody builds on them. Fixed for the whole game. */
  obstacles: Obstacle[] = [];
  private readonly defs: readonly FactionDef[];
  private readonly humans: readonly number[];
  private readonly names: Readonly<Record<number, string>>;

  constructor(readonly mode: ModeConfig, seed: number, opts: WorldOptions = {}) {
    this.rng = new Rng(seed);
    const rivals = opts.rivals ?? DEFAULT_RIVALS;
    this.map = opts.map ?? 'meadow';
    const room = roomFor(rivals) * SIZES[opts.mapSize ?? 'medium'].area;
    this.defs = teamDefs(rivals);
    this.humans = opts.humans ?? [PLAYER];
    this.names = opts.names ?? {};
    this.neutralCap = Math.round(mode.neutrals * room * (this.map === 'crowd' ? 1.5 : 1));
    this.w = opts.size?.[0] ?? Math.round(mode.worldW * Math.sqrt(room));
    this.h = opts.size?.[1] ?? Math.round(mode.worldH * Math.sqrt(room));
    this.aiOn = opts.ai ?? true;
    this.victoryOn = opts.victory ?? true;
    this.grid = new Grid(this.w, this.h);
    this.createFactions();
    if (opts.scenario) {
      opts.scenario(this);
      this.neutralCap = this.blobs.filter((b) => b.faction === NEUTRAL).length;
    } else {
      this.setup();
    }
    this.refreshCounts();
    this.record();
    this.events = []; // setup noise (initial town halls) isn't news
  }

  // ───────────────────────────── setup ─────────────────────────────

  private createFactions(): void {
    const n = this.defs.length;
    this.defs.forEach((d, i) => {
      this.factions.push({
        id: i,
        name: this.names[i] ?? d.name,
        color: d.color,
        isPlayer: this.humans.includes(i),
        isNeutral: !!d.neutral,
        ai: d.neutral || this.humans.includes(i) ? null : (d.ai ?? null),
        aiTimer: 2 + i,
        policeTimer: 0,
        gold: d.neutral ? 0 : this.mode.startGold,
        earned: 0,
        research: 0,
        tech: 0,
        reputation: 0.65,
        grudge: new Array<number>(n).fill(0),
        stats: { converted: 0, lost: 0, births: 0, deaths: 0, attacks: 0, arrests: 0, kills: 0, jailed: 0, lessons: 0, usurped: 0 },
        pop: 0,
        police: 0,
        cap: 0,
        counts: emptyCounts(),
        levels: emptyCounts(),
      });
    });
  }

  /** Ponds or trees in the open ground between the towns. Meadow and Crowded Middle have none. */
  private placeObstacles(): void {
    if (this.map !== 'lakes' && this.map !== 'woods') return;
    const rng = this.rng;
    const lakes = this.map === 'lakes';
    const halls = this.defs.filter((d) => !d.neutral).map((d) => [d.pos[0] * this.w, d.pos[1] * this.h]);
    const area = (this.w * this.h) / (1800 * 1500);
    const want = Math.round((lakes ? 4 : 14) * area);
    for (let tries = 0; this.obstacles.length < want && tries < want * 60; tries++) {
      const r = lakes ? rng.range(110, 200) : rng.range(40, 85);
      const x = rng.range(r + 80, this.w - r - 80);
      const y = rng.range(r + 80, this.h - r - 80);
      // Leave every town room to grow, and a path between obstacles.
      if (halls.some(([hx, hy]) => dist2(hx, hy, x, y) < (r + (lakes ? 330 : 270)) ** 2)) continue;
      if (this.obstacles.some((o) => dist2(o.x, o.y, x, y) < (o.r + r + (lakes ? 120 : 70)) ** 2)) continue;
      this.obstacles.push({ x, y, r, kind: lakes ? 'pond' : rng.chance(0.25) ? 'rock' : 'trees' });
    }
  }

  /** The obstacle a point is inside (with `pad` to spare), if any. */
  obstacleAt(x: number, y: number, pad = OBSTACLE_PAD): Obstacle | null {
    for (const o of this.obstacles) if (dist2(o.x, o.y, x, y) < (o.r + pad) ** 2) return o;
    return null;
  }

  /** The nearest point to (x, y) that's outside every obstacle. */
  free(x: number, y: number, pad = OBSTACLE_PAD): { x: number; y: number } {
    for (let i = 0; i < 3; i++) {
      const o = this.obstacleAt(x, y, pad);
      if (!o) break;
      let dx = x - o.x;
      let dy = y - o.y;
      let d = Math.sqrt(dx * dx + dy * dy);
      if (d < 1e-6) {
        dx = 1;
        dy = 0;
        d = 1;
      }
      const k = (o.r + pad + 1) / d;
      x = clamp(o.x + dx * k, 20, this.w - 20);
      y = clamp(o.y + dy * k, 20, this.h - 20);
    }
    return { x, y };
  }

  /** The normal map: a town per team and camps of wanderers in between. */
  private setup(): void {
    const rng = this.rng;
    const halls: Building[] = [];
    this.placeObstacles();
    this.defs.forEach((d, i) => {
      if (d.neutral) return;
      const hx = d.pos[0] * this.w;
      const hy = d.pos[1] * this.h;
      const hall = this.placeBuilding(i, 'hall', hx, hy);
      halls.push(hall);
      let bestCop: Blob | null = null;
      for (let k = 0; k < this.mode.blobsPerFaction; k++) {
        const a = rng.range(0, Math.PI * 2);
        const r = rng.range(50, 140);
        const kid = k >= this.mode.blobsPerFaction - 2;
        const b = this.spawnBlob(
          i,
          hx + cos(a) * r,
          hy + sin(a) * r,
          randomTraits(rng, d.bias),
          kid ? rng.range(1, ADULT_AGE - 2) : rng.range(ADULT_AGE + 4, 35),
          hx,
          hy,
        );
        if (!kid && (!bestCop || b.traits.honesty - b.traits.violence > bestCop.traits.honesty - bestCop.traits.violence)) {
          bestCop = b;
        }
      }
      if (bestCop) bestCop.role = 'police';
    });

    // Neutral wanderers live in camps away from the towns (or, on Crowded Middle, mostly in one big one).
    const crowd = this.map === 'crowd';
    const camps: [number, number][] = crowd ? [[this.w / 2, this.h / 2]] : [];
    const campCount = crowd ? 3 : Math.max(4, Math.round(this.neutralCap / 7));
    for (let tries = 0; camps.length < campCount && tries < 500; tries++) {
      const x = rng.range(120, this.w - 120);
      const y = rng.range(120, this.h - 120);
      const farFromTowns = halls.every((h) => dist2(h.x, h.y, x, y) > 330 * 330);
      const farFromCamps = camps.every(([cx, cy]) => dist2(cx, cy, x, y) > 220 * 220);
      const clear = !this.obstacleAt(x, y, 140);
      if (farFromTowns && farFromCamps && clear) camps.push([x, y]);
    }
    if (camps.length === 0) camps.push([this.w / 2, this.h / 2]);
    for (let k = 0; k < this.neutralCap; k++) {
      // Crowded Middle: three in four wanderers live in the middle.
      const mid = crowd && k % 4 !== 3;
      const [cx, cy] = mid ? camps[0] : camps[k % camps.length];
      const a = rng.range(0, Math.PI * 2);
      const r = rng.range(0, mid ? 230 : 110);
      this.spawnBlob(NEUTRAL, cx + cos(a) * r, cy + sin(a) * r, randomTraits(rng), rng.range(3, 60), cx, cy);
    }
  }

  spawnBlob(faction: number, x: number, y: number, traits: Traits, age: number, homeX: number, homeY: number): Blob {
    const rng = this.rng;
    ({ x, y } = this.free(clamp(x, 20, this.w - 20), clamp(y, 20, this.h - 20)));
    const b: Blob = {
      id: this.nextId++,
      name: blobName(rng),
      faction,
      x,
      y,
      px: x,
      py: y,
      vx: 0,
      vy: 0,
      tx: x,
      ty: y,
      wanderTimer: rng.range(0, 3),
      homeX,
      homeY,
      home: -1,
      job: 'social',
      jobCd: rng.range(0, 2),
      lessonCd: 0,
      area: null,
      traits,
      loyalty: 0,
      health: 1,
      age,
      lifespan: 85 + rng.range(-8, 8),
      role: 'citizen',
      order: { kind: 'none' },
      byPlayer: false,
      heat: 0,
      jail: 0,
      jailedBy: -1,
      talkCd: rng.range(0, 4),
      attackCd: 0,
      breedCd: rng.range(5, 30),
      scanCd: rng.range(0, 1),
      urgeCd: rng.range(0, 1),
      stun: 0,
      mood: 'calm',
      moodTime: 0,
      lookAt: -1,
      alive: true,
    };
    b.loyalty = faction === NEUTRAL ? 0.12 + 0.3 * traits.allegiance : 0.55 + 0.4 * traits.allegiance;
    this.blobs.push(b);
    this.byId.set(b.id, b);
    return b;
  }

  placeBuilding(faction: number, kind: BuildingKind, x: number, y: number): Building {
    const b: Building = { id: this.nextId++, kind, faction, x, y, focus: 'science', capture: 0, captureBy: -1, level: 1 };
    this.buildings.push(b);
    this.buildingsVersion++;
    this.emit('build', x, y, { faction, text: BUILDINGS[kind].label, target: b.id });
    return b;
  }

  // ───────────────────────────── tick ─────────────────────────────

  command(c: Command): void {
    this.cmds.push(c);
  }

  tick(dt: number): void {
    if (this.outcome) return;
    this.time += dt;
    for (const c of this.cmds) this.applyCommand(c);
    this.cmds.length = 0;
    for (const b of this.blobs) {
      b.px = b.x;
      b.py = b.y;
    }
    this.refreshCounts();
    this.grid.rebuild(this.blobs);

    economy(this, dt);
    housing(this, dt);
    if (this.aiOn) ai(this, dt);
    jobs(this, dt);
    behaviour(this, dt);
    social(this, dt);
    violence(this, dt);
    police(this, dt);
    life(this, dt);
    towns(this, dt);

    this.cleanup();
    this.victoryTimer -= dt;
    if (this.victoryOn && this.victoryTimer <= 0) {
      this.victoryTimer = 1;
      this.checkVictory();
    }
    const last = this.history.rows.at(-1)?.[0] ?? -Infinity;
    if (this.outcome || this.time >= last + this.history.every - 1e-6) this.record();
  }

  /** Add a row to the history. */
  private record(): void {
    this.refreshCounts();
    const h = this.history;
    const row = [this.time];
    for (const f of this.factions) {
      let levels = 0;
      for (const k in f.levels) levels += f.levels[k as BuildingKind];
      row.push(f.pop, f.earned, levels, f.tech);
    }
    h.rows.push(row);
    if (h.rows.length > HISTORY_ROWS) {
      // An odd count, so the newest row stays.
      h.rows = h.rows.filter((_, i) => i % 2 === 0);
      h.every *= 2;
    }
  }

  drainEvents(): SimEvent[] {
    const e = this.events;
    this.events = [];
    return e;
  }

  refreshCounts(): void {
    for (const f of this.factions) {
      f.pop = 0;
      f.police = 0;
      f.counts = emptyCounts();
      f.levels = emptyCounts();
    }
    for (const b of this.blobs) {
      if (!b.alive) continue;
      const f = this.factions[b.faction];
      f.pop++;
      if (b.role === 'police') f.police++;
    }
    for (const bl of this.buildings) {
      this.factions[bl.faction].counts[bl.kind]++;
      this.factions[bl.faction].levels[bl.kind] += bl.level;
    }
    for (const f of this.factions) {
      f.cap = f.isNeutral ? this.neutralCap : f.counts.hall * HALL_CAP + (f.levels.hall - f.counts.hall) * HALL_LEVEL_CAP + f.levels.house * HOUSE_CAP;
    }
  }

  private cleanup(): void {
    if (!this.blobs.some((b) => !b.alive)) return;
    this.blobs = this.blobs.filter((b) => {
      if (!b.alive) this.byId.delete(b.id);
      return b.alive;
    });
  }

  private checkVictory(): void {
    this.refreshCounts();
    const total = this.blobs.length;
    if (total === 0) return;
    const humans = this.factions.filter((f) => f.isPlayer);
    if (humans.length > 0 && humans.every((f) => f.pop === 0)) {
      const best = this.leader();
      const gone = humans.length === 1 ? 'Your last blob is gone.' : 'Every player’s blobs are gone.';
      this.outcome = { winner: best, reason: `${gone} ${this.factions[best].name} lead the world.` };
      return;
    }
    for (const f of this.factions) {
      if (f.isNeutral) continue;
      if (f.pop / total >= this.mode.winShare) {
        const share = Math.round((100 * f.pop) / total);
        this.outcome = { winner: f.id, share, reason: `${f.name} united ${share}% of the world.` };
        return;
      }
    }
  }

  leader(): number {
    let best = -1;
    for (const f of this.factions) if (!f.isNeutral && (best < 0 || f.pop > this.factions[best].pop)) best = f.id;
    return best;
  }

  // ───────────────────────────── online play ─────────────────────────────

  /** A fingerprint of the game state. Two players whose fingerprints differ have drifted apart. */
  hash(): number {
    const h = new Hasher();
    h.num(this.time);
    h.num(this.rng.state);
    h.num(this.nextId);
    for (const b of this.blobs) {
      h.num(b.id);
      h.num(b.faction);
      h.num(b.x);
      h.num(b.y);
      h.num(b.vx);
      h.num(b.vy);
      h.num(b.loyalty);
      h.num(b.health);
      h.num(b.age);
      h.num(b.jail);
      h.str(b.role);
      h.str(b.job);
      h.str(b.order.kind);
    }
    for (const b of this.buildings) {
      h.num(b.id);
      h.num(b.faction);
      h.str(b.kind);
      h.num(b.capture);
      h.num(b.level);
    }
    for (const f of this.factions) {
      h.num(f.gold);
      h.num(f.research);
      h.num(f.tech);
      h.num(f.reputation);
      h.num(f.ai ? 1 : 0);
    }
    return h.h;
  }

  /** The whole game state as text. */
  save(): string {
    const s: Snapshot = {
      time: this.time,
      blobs: this.blobs,
      buildings: this.buildings,
      factions: this.factions,
      rng: this.rng.state,
      nextId: this.nextId,
      victoryTimer: this.victoryTimer,
      housingTimer: this.housingTimer,
      townTimer: this.townTimer,
      neutralCap: this.neutralCap,
      outcome: this.outcome,
      history: this.history,
    };
    return JSON.stringify(s, saveNum);
  }

  /** Replace the game state with one from `save()` (same mode and map). */
  load(text: string): void {
    const s = JSON.parse(text, loadNum) as Snapshot;
    this.time = s.time;
    this.blobs = s.blobs;
    this.byId.clear();
    for (const b of this.blobs) this.byId.set(b.id, b);
    this.buildings = s.buildings;
    this.factions = s.factions;
    this.rng.state = s.rng;
    this.nextId = s.nextId;
    this.victoryTimer = s.victoryTimer;
    this.housingTimer = s.housingTimer;
    this.townTimer = s.townTimer;
    this.neutralCap = s.neutralCap;
    this.outcome = s.outcome;
    this.history = s.history ?? { every: HISTORY_EVERY, rows: [] };
    this.cmds.length = 0;
    this.events = [];
    this.buildingsVersion++;
    this.refreshCounts();
  }

  // ───────────────────────────── commands ─────────────────────────────

  private applyCommand(c: Command): void {
    const f = this.factions[c.faction];
    if (!f || f.isNeutral) return;
    switch (c.type) {
      case 'build': {
        const r = this.canPlace(c.faction, c.kind, c.x, c.y);
        if (!r.ok) {
          if (f.isPlayer) this.emit('notice', c.x, c.y, { faction: c.faction, text: r.reason });
          return;
        }
        f.gold -= buildCost(f, c.kind);
        this.placeBuilding(c.faction, c.kind, c.x, c.y);
        return;
      }
      case 'upgrade': {
        const b = this.buildings.find((x) => x.id === c.building);
        if (!b || b.faction !== c.faction || b.level >= MAX_LEVEL) return;
        const cost = upgradeCost(f, b);
        if (f.gold < cost) return;
        f.gold -= cost;
        b.level++;
        this.emit('upgrade', b.x, b.y, { faction: c.faction, target: b.id, text: `${BUILDINGS[b.kind].label} to level ${b.level}` });
        return;
      }
      case 'upgradeAll': {
        const plan = this.levelAllPlan(c.faction, c.kind);
        for (const b of plan.todo.slice(0, plan.can)) {
          f.gold -= upgradeCost(f, b);
          b.level++;
          this.emit('upgrade', b.x, b.y, { faction: c.faction, target: b.id, text: `${BUILDINGS[b.kind].label} to level ${b.level}` });
        }
        return;
      }
      case 'order': {
        const units = c.ids
          .map((id) => this.byId.get(id))
          .filter((b): b is Blob => !!b && this.commandable(b, c.faction));
        const target = c.target !== undefined ? this.byId.get(c.target) : undefined;
        units.forEach((b, i) => {
          b.area = null;
          if (c.order === 'stop') {
            this.endOrder(b);
          } else if (c.order === 'usurp' && c.building !== undefined) {
            const bld = this.buildings.find((x) => x.id === c.building);
            if (!bld || bld.faction === b.faction) return;
            this.endOrder(b);
            b.order = { kind: 'usurp', building: bld.id };
            b.byPlayer = true;
          } else if (c.order === 'move' && c.x !== undefined && c.y !== undefined) {
            const a = i * 2.4;
            const r = 16 * Math.sqrt(i);
            this.endOrder(b);
            b.order = { kind: 'move', x: clamp(c.x + cos(a) * r, 20, this.w - 20), y: clamp(c.y + sin(a) * r, 20, this.h - 20) };
            b.byPlayer = true;
          } else if (c.order === 'befriend' && target && target.faction !== b.faction) {
            this.endOrder(b);
            b.order = { kind: 'befriend', target: target.id, tries: 0 };
            b.role = 'ambassador';
            b.byPlayer = true;
          } else if (c.order === 'teach' && target && target !== b && target.faction === b.faction && target.alive) {
            this.endOrder(b);
            b.order = { kind: 'teach', target: target.id, tries: 0, gain: {} };
            b.byPlayer = true;
          } else if (c.order === 'attack' && target && target.faction !== b.faction) {
            this.endOrder(b);
            b.order = { kind: 'attack', target: target.id, hits: 0 };
            b.byPlayer = true;
          }
        });
        return;
      }
      case 'befriendArea':
        this.befriendArea(c.faction, c.ids, c.x, c.y, c.r, c.target);
        return;
      case 'job': {
        for (const id of c.ids) {
          const b = this.byId.get(id);
          if (!b || !this.commandable(b, c.faction)) continue;
          b.job = c.job;
          b.jobCd = 0;
        }
        return;
      }
      case 'autoUsurp': {
        const bld = this.buildings.find((x) => x.id === c.building);
        if (!bld || bld.faction === c.faction) return;
        const free = this.blobs
          .filter((b) => this.commandable(b, c.faction) && b.age >= ADULT_AGE && b.order.kind === 'none')
          .sort((a, b) => dist2(a.x, a.y, bld.x, bld.y) - dist2(b.x, b.y, bld.x, bld.y))
          .slice(0, c.count);
        if (free.length === 0) {
          if (f.isPlayer) this.emit('notice', bld.x, bld.y, { faction: c.faction, text: 'No free blobs to send' });
          return;
        }
        for (const b of free) {
          b.area = null;
          b.order = { kind: 'usurp', building: bld.id };
          b.byPlayer = f.isPlayer;
        }
        if (f.isPlayer) {
          this.emit('notice', bld.x, bld.y, {
            faction: c.faction,
            text: `🏳️ ${free.length} blobs go to take over the ${BUILDINGS[bld.kind].label}`,
          });
        }
        return;
      }
      case 'autoBefriend':
      case 'autoAttack': {
        const t = this.byId.get(c.target);
        if (!t || t.faction === c.faction) return;
        const friendly = c.type === 'autoBefriend';
        const want = friendly ? Math.max(1, c.count ?? 1) : 1;
        const picks: { b: Blob; s: number }[] = [];
        for (const b of this.blobs) {
          if (!this.commandable(b, c.faction) || b.age < ADULT_AGE) continue;
          if (b.order.kind === 'befriend' || b.order.kind === 'attack' || b.order.kind === 'usurp') continue;
          const skill = friendly ? talkScore(b.traits) : b.traits.strength + 0.5 * b.traits.fitness;
          picks.push({ b, s: skill - Math.sqrt(dist2(b.x, b.y, t.x, t.y)) / 2000 });
        }
        picks.sort((a, z) => z.s - a.s);
        const chosen = picks.slice(0, want).map((p) => p.b);
        if (chosen.length === 0) {
          if (f.isPlayer) this.emit('notice', t.x, t.y, { faction: c.faction, text: 'No free blob to send' });
          return;
        }
        if (friendly) {
          this.befriendArea(c.faction, chosen.map((b) => b.id), t.x, t.y, 150, t.id);
          return;
        }
        const best = chosen[0];
        best.area = null;
        best.order = { kind: 'attack', target: t.id, hits: 0 };
        best.role = 'citizen';
        best.byPlayer = true;
        if (f.isPlayer) {
          this.emit('notice', t.x, t.y, { faction: c.faction, blob: best.id, target: t.id, text: `${best.name} goes to bonk ${t.name} 💥` });
        }
        return;
      }
      case 'focus': {
        const s = this.buildings.find((b) => b.id === c.building && b.faction === c.faction && b.kind === 'school');
        if (s) s.focus = c.trait;
        return;
      }
      case 'gift':
        f.gold += Math.max(0, c.gold);
        return;
      case 'setAi':
        // A player left (the computer takes over) or came back.
        f.ai = c.on ? (this.defs[c.faction].ai ?? null) : null;
        return;
    }
  }

  /**
   * Aim a group at a crowd: each blob takes a different stranger near (x, y),
   * and keeps going until nobody in the area is left to befriend.
   */
  befriendArea(faction: number, ids: number[], x: number, y: number, r: number, first?: number): void {
    const units = ids.map((id) => this.byId.get(id)).filter((b): b is Blob => !!b && this.commandable(b, faction));
    if (units.length === 0) return;
    const probe = units[0];
    const pool = this.blobs.filter((t) => isStranger(probe, t) && dist2(t.x, t.y, x, y) <= r * r);
    const firstT = first !== undefined ? this.byId.get(first) : undefined;
    if (firstT && isStranger(probe, firstT) && !pool.includes(firstT)) pool.push(firstT);
    const f = this.factions[faction];
    if (pool.length === 0) {
      if (f.isPlayer) this.emit('notice', x, y, { faction, text: 'No strangers there to befriend' });
      return;
    }
    const taken = new Map<number, number>();
    if (firstT && pool.includes(firstT)) taken.set(firstT.id, -1); // first pick goes to the tapped blob
    for (const b of units) {
      // Nearest stranger with the fewest friends already heading there.
      let best: Blob | null = null;
      let bs = Infinity;
      for (const t of pool) {
        const load = taken.get(t.id) ?? 0;
        const s = Math.sqrt(dist2(b.x, b.y, t.x, t.y)) + 400 * Math.max(0, load);
        if (s < bs) {
          bs = s;
          best = t;
        }
      }
      if (!best) break;
      taken.set(best.id, Math.max(0, taken.get(best.id) ?? 0) + 1);
      this.endOrder(b);
      b.order = { kind: 'befriend', target: best.id, tries: 0 };
      b.role = 'ambassador';
      b.byPlayer = f.isPlayer;
      b.area = { x, y, r, until: this.time + 120 };
    }
    if (f.isPlayer) {
      const n = units.length;
      this.emit('notice', x, y, {
        faction,
        text: `💗 ${n > 1 ? `${n} blobs go` : `${units[0].name} goes`} to befriend ${pool.length} stranger${pool.length > 1 ? 's' : ''}`,
      });
    }
  }

  /** A building changes hands after a peaceful takeover. */
  usurp(bld: Building, to: number): void {
    const from = bld.faction;
    bld.faction = to;
    bld.capture = 0;
    bld.captureBy = -1;
    this.buildingsVersion++;
    this.factions[to].stats.usurped++;
    const victim = this.factions[from];
    victim.grudge[to] = clamp01(victim.grudge[to] + 0.08);
    for (const b of this.blobs) {
      if (b.order.kind === 'usurp' && b.order.building === bld.id) {
        this.endOrder(b);
        b.mood = 'happy';
        b.moodTime = 2;
      }
    }
    this.emit('usurp', bld.x, bld.y, { faction: to, other: from, target: bld.id, text: BUILDINGS[bld.kind].label });
  }

  /**
   * "Level up all" for a team's buildings of one kind: the ones below max level, lowest first
   * (they cost least, so the gold goes furthest), what raising them all costs, and how many
   * of them (from the front) the team can pay for now.
   */
  levelAllPlan(faction: number, kind: BuildingKind): { todo: Building[]; total: number; can: number; canCost: number } {
    const f = this.factions[faction];
    const todo = this.buildings
      .filter((b) => b.faction === faction && b.kind === kind && b.level < MAX_LEVEL)
      .sort((a, b) => a.level - b.level || a.id - b.id);
    let total = 0;
    let can = 0;
    let canCost = 0;
    todo.forEach((b, i) => {
      const cost = upgradeCost(f, b);
      total += cost;
      if (can === i && f.gold >= canCost + cost) {
        can++;
        canCost += cost;
      }
    });
    return { todo, total, can, canCost };
  }

  commandable(b: Blob, faction: number): boolean {
    return b.alive && b.faction === faction && b.jail <= 0 && b.role !== 'police';
  }

  // ───────────────────────────── helpers used by systems ─────────────────────────────

  emit(type: SimEventType, x: number, y: number, o: Partial<SimEvent> = {}): void {
    this.events.push({ type, x, y, faction: -1, other: -1, blob: -1, target: -1, text: '', ...o });
  }

  endOrder(b: Blob): void {
    b.order = { kind: 'none' };
    if (b.role === 'ambassador') b.role = 'citizen';
    b.byPlayer = false;
  }

  loyaltyCap(b: Blob): number {
    return b.faction === NEUTRAL ? 0.2 + 0.3 * b.traits.allegiance : 0.5 + 0.5 * b.traits.allegiance;
  }

  hall(faction: number): Building | undefined {
    return this.buildings.find((b) => b.faction === faction && b.kind === 'hall');
  }

  territoryRadius(faction: number): number {
    return 190 + 12 * this.factions[faction].tech;
  }

  inTerritory(faction: number, x: number, y: number): boolean {
    const r = this.territoryRadius(faction);
    return this.buildings.some((b) => b.faction === faction && dist2(b.x, b.y, x, y) <= r * r);
  }

  /** Whose land is this point in (closest qualifying building), or -1. */
  territoryAt(x: number, y: number): number {
    let best = -1;
    let bd = Infinity;
    for (const b of this.buildings) {
      const r = this.territoryRadius(b.faction);
      const d = dist2(b.x, b.y, x, y);
      if (d <= r * r && d < bd) {
        bd = d;
        best = b.faction;
      }
    }
    return best;
  }

  canPlace(faction: number, kind: BuildingKind, x: number, y: number): { ok: boolean; reason: string } {
    const def = BUILDINGS[kind];
    if (x < 50 || y < 50 || x > this.w - 50 || y > this.h - 50) return { ok: false, reason: 'Too close to the edge' };
    if (!this.inTerritory(faction, x, y)) return { ok: false, reason: 'Build inside your land' };
    const o = this.obstacleAt(x, y, def.radius + 6);
    if (o) return { ok: false, reason: o.kind === 'pond' ? 'Can’t build on water' : o.kind === 'rock' ? 'Can’t build on rocks' : 'Can’t build in the trees' };
    for (const o of this.buildings) {
      const min = def.radius + BUILDINGS[o.kind].radius + 8;
      if (dist2(o.x, o.y, x, y) < min * min) return { ok: false, reason: 'Too close to another building' };
    }
    if (this.factions[faction].gold < buildCost(this.factions[faction], kind)) return { ok: false, reason: 'Not enough gold' };
    return { ok: true, reason: '' };
  }

  nearestBuilding(faction: number, x: number, y: number, kind?: BuildingKind): Building | undefined {
    let best: Building | undefined;
    let bd = Infinity;
    for (const b of this.buildings) {
      if (b.faction !== faction || (kind && b.kind !== kind)) continue;
      const d = dist2(b.x, b.y, x, y);
      if (d < bd) {
        bd = d;
        best = b;
      }
    }
    return best;
  }

  hasSchoolNear(faction: number, x: number, y: number): boolean {
    if (faction === NEUTRAL || this.factions[faction].counts.school === 0) return false;
    return this.buildings.some((b) => {
      if (b.kind !== 'school' || b.faction !== faction) return false;
      const r = schoolRadius(b);
      return dist2(b.x, b.y, x, y) <= r * r;
    });
  }

  convert(b: Blob, to: number, how: 'talk' | 'fear'): void {
    const from = b.faction;
    if (from === to || !b.alive) return;
    this.factions[from].stats.lost++;
    this.factions[to].stats.converted++;
    b.faction = to;
    b.loyalty = how === 'fear' ? 0.12 : to === NEUTRAL ? 0.2 : 0.3 + 0.4 * b.traits.allegiance;
    b.role = 'citizen';
    b.job = 'social';
    b.area = null;
    b.home = -1;
    this.endOrder(b);
    const h = this.hall(to);
    if (h) {
      b.homeX = h.x + this.rng.range(-60, 60);
      b.homeY = h.y + this.rng.range(-60, 60);
    } else {
      b.homeX = b.x;
      b.homeY = b.y;
    }
    b.wanderTimer = this.rng.range(1, 4);
    b.mood = how === 'fear' ? 'scared' : 'happy';
    b.moodTime = 2.5;
    const type: SimEventType = how === 'fear' ? 'fearConvert' : to === NEUTRAL ? 'defect' : 'convert';
    this.emit(type, b.x, b.y, { faction: to, other: from, blob: b.id, text: b.name });
  }

  kill(b: Blob, cause: 'old' | 'violence', killer?: Blob): void {
    if (!b.alive) return;
    b.alive = false;
    this.factions[b.faction].stats.deaths++;
    this.emit(cause === 'old' ? 'death' : 'kill', b.x, b.y, {
      faction: killer ? killer.faction : b.faction,
      other: b.faction,
      blob: killer ? killer.id : b.id,
      target: b.id,
      text: b.name,
    });
  }

  jail(b: Blob, cop: Blob): void {
    const f = this.factions[cop.faction];
    const station = this.nearestBuilding(cop.faction, b.x, b.y, 'police') ?? this.hall(cop.faction);
    b.jail = 16 + 2 * f.tech;
    b.jailedBy = cop.faction;
    b.heat = 0;
    this.endOrder(b);
    if (station) {
      b.x = station.x + this.rng.range(-16, 16);
      b.y = station.y + 22 + this.rng.range(0, 8);
    }
    b.px = b.x;
    b.py = b.y;
    b.vx = 0;
    b.vy = 0;
    b.mood = 'sad';
    b.moodTime = b.jail;
    const bf = this.factions[b.faction];
    bf.stats.jailed++;
    f.stats.arrests++;
    bf.reputation = clamp01(bf.reputation - 0.02);
    f.reputation = clamp01(f.reputation + 0.01);
    this.emit('arrest', b.x, b.y, { faction: cop.faction, other: b.faction, blob: b.id, target: cop.id, text: b.name });
  }
}
