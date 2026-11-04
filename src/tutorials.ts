import type { ModeId } from './modes';
import { BUILD_MENU, FOUNTAIN_RADIUS, NEUTRAL, PLAYER } from './sim/config';
import { randomTraits, type Traits } from './sim/traits';
import type { Blob, Building, BuildingKind, SimEvent } from './sim/types';
import { dist2 } from './sim/util';
import type { World, WorldOptions } from './sim/world';

/** Text that differs between Casual (taps) and Pro (mouse and keys). */
export type Text = string | readonly [casual: string, pro: string];
export const say = (t: Text, mode: ModeId): string => (typeof t === 'string' ? t : t[mode === 'casual' ? 0 : 1]);

/** Things the player did in the UI that the sim can't see. */
export type UiDid = 'team' | 'box' | 'groupSave' | 'groupRecall' | 'rightClick';

export interface TutCtx {
  readonly w: World;
  /** Your own blobs that are selected right now. */
  readonly sel: readonly Blob[];
  readonly did: ReadonlySet<UiDid>;
  /** Scratch numbers the level keeps between frames (ids, counters). */
  readonly mem: Record<string, number>;
  /** Sim events from this frame. */
  readonly events: readonly SimEvent[];
}

export interface Progress {
  n: number;
  of: number;
  label?: string;
}

/** A label bobbing over something on the map ("👇 Grumpo"), in world coordinates. */
export interface Pointer {
  x: number;
  y: number;
  label: string;
}

export interface Step {
  text: Text;
  sub?: Text;
  done(c: TutCtx): boolean;
  progress?(c: TutCtx): Progress;
  /** What to point at on the map while this step is up. */
  point?(c: TutCtx): readonly Pointer[];
}

export interface Level {
  id: string;
  icon: string;
  title: string;
  /** Short list of the mechanics it shows. */
  teaches: string;
  /** Only offered in this mode. */
  only?: ModeId;
  size?: readonly [number, number];
  /** Normal win check on (only the last level). */
  victory?: boolean;
  /** Build buttons shown (none if left out). */
  build?: readonly BuildingKind[];
  /** World rectangle [x0, y0, x1, y1] to fit on screen at the start. */
  view: readonly [number, number, number, number];
  setup(w: World, mem: Record<string, number>): void;
  /** Runs every frame, for scripted rivals. */
  script?(w: World, mem: Record<string, number>): void;
  onEvent?(e: SimEvent, c: TutCtx): void;
  steps: readonly Step[];
  outro: Text;
}

// ───────────────────────────── helpers ─────────────────────────────

// Taller than it is wide so phones (where the map sits above the panel) never see past the edge.
const SIZE = [1400, 1500] as const;
const HX = 470;
const HY = 720;
const PINK = 2;
const ORANGE = 3;

const CHARMING: Partial<Traits> = { teaching: 0.8, kindness: 0.8, honesty: 0.75, intelligence: 0.65, patience: 0.6, violence: 0.1 };
const FRIENDLY: Partial<Traits> = { openness: 0.85, allegiance: 0.12, violence: 0.15 };

function add(w: World, f: number, x: number, y: number, t: Partial<Traits> = {}, age = 26): Blob {
  const traits = Object.assign(randomTraits(w.rng), t);
  const hall = f === NEUTRAL ? undefined : w.hall(f);
  return w.spawnBlob(f, x, y, traits, age, hall?.x ?? x, hall?.y ?? y);
}

/** `n` blobs scattered around (x, y). */
function crowd(w: World, f: number, n: number, x: number, y: number, r: number, t: Partial<Traits> = {}, age = 26): Blob[] {
  const out: Blob[] = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2 + w.rng.range(-0.3, 0.3);
    const d = r * Math.sqrt(w.rng.range(0.15, 1));
    out.push(add(w, f, x + Math.cos(a) * d, y + Math.sin(a) * d, t, age + w.rng.range(-4, 6)));
  }
  return out;
}

/** A town hall. Yours comes with its police officer already hired, as in a real game. */
function town(w: World, f: number, x = HX, y = HY): Building {
  const hall = w.placeBuilding(f, 'hall', x, y);
  if (f === PLAYER) add(w, f, x - 50, y + 45, { honesty: 0.85, strength: 0.7, fitness: 0.7, violence: 0.05 }).role = 'police';
  return hall;
}
const gold = (w: World, g: number): void => {
  w.factions[PLAYER].gold = g;
};
const me = (c: TutCtx) => c.w.factions[PLAYER];
const converted = (c: TutCtx): number => me(c).stats.converted;
const mine = (w: World): Blob[] => w.blobs.filter((b) => b.alive && b.faction === PLAYER);
/** Your blobs out befriending (or still working through a crowd). */
const befriending = (w: World): number => mine(w).filter((b) => b.order.kind === 'befriend' || b.area).length;
const byId = (w: World, id: number | undefined): Blob | undefined => (id === undefined ? undefined : w.byId.get(id));
const bld = (w: World, id: number | undefined): Building | undefined => w.buildings.find((b) => b.id === id);

const onBlob = (b: Blob | undefined, label: string): Pointer[] => (b && b.alive ? [{ x: b.x, y: b.y - 18, label }] : []);
const onBuilding = (b: Building | undefined, label: string): Pointer[] => (b ? [{ x: b.x, y: b.y - 44, label }] : []);
/** The stranger nearest your town, for "tap a stranger" steps. */
const nearestStranger = (w: World): Blob | undefined => {
  const h = w.hall(PLAYER);
  if (!h) return undefined;
  let best: Blob | undefined;
  let bd = Infinity;
  for (const b of w.blobs) {
    if (b.faction !== NEUTRAL || !b.alive) continue;
    const d = dist2(b.x, b.y, h.x, h.y);
    if (d < bd) {
      bd = d;
      best = b;
    }
  }
  return best;
};

const SELECT_GROUP: Text = ['Tap a blue blob, then tap 👥 Select nearby', 'Drag a box around your blue blobs'];
const SELECT_GROUP_SUB: Text = [
  'That picks every grown-up around it. 👥 Team can pick groups too.',
  'Hold the left button on empty ground and drag. Ctrl+A grabs everyone.',
];

// ───────────────────────────── levels ─────────────────────────────

export const LEVELS: readonly Level[] = [
  {
    id: 'hello',
    icon: '👋',
    title: 'Say hello',
    teaches: 'Selecting · Befriending',
    view: [HX - 130, HY - 150, HX + 420, HY + 150],
    setup(w, m) {
      town(w, PLAYER);
      crowd(w, PLAYER, 3, HX, HY + 20, 60, CHARMING);
      m.stranger = add(w, NEUTRAL, HX + 310, HY - 10, FRIENDLY).id;
    },
    steps: [
      {
        text: ['Tap one of your blue blobs', 'Click one of your blue blobs'],
        sub: 'Blue blobs are your team. Their panel shows what each one is good at.',
        done: (c) => c.sel.length > 0 || converted(c) > 0,
      },
      {
        text: ['Now tap the grey stranger', 'Now right-click the grey stranger'],
        sub: ['Your blob walks over for a chat.', 'Or press F (Befriend), then click them. Your blob walks over for a chat.'],
        done: (c) => befriending(c.w) > 0 || converted(c) > 0,
        point: (c) => onBlob(byId(c.w, c.mem.stranger), 'Stranger'),
      },
      {
        text: 'Let them chat…',
        sub: 'Every chat weakens their ties to their old life. At zero, they join you. Kind, charming, honest blobs persuade fastest.',
        done: (c) => converted(c) > 0,
      },
    ],
    outro: 'Befriending is how you grow. No fighting needed!',
  },

  {
    id: 'controls',
    only: 'pro',
    icon: '⌨️',
    title: 'Pro controls',
    teaches: 'Box select · Groups · Right-click',
    view: [HX - 200, HY - 190, HX + 460, HY + 190],
    setup(w) {
      town(w, PLAYER);
      crowd(w, PLAYER, 4, HX - 90, HY - 70, 45, CHARMING);
      crowd(w, PLAYER, 4, HX + 70, HY + 90, 45, CHARMING);
      crowd(w, NEUTRAL, 5, HX + 340, HY, 60, FRIENDLY);
    },
    steps: [
      {
        text: 'Drag a box around some blue blobs',
        sub: 'Hold the left button on empty ground and drag. Shift+drag adds more.',
        done: (c) => c.did.has('box') && c.sel.length >= 2,
      },
      {
        text: 'Press Ctrl+1 to save them as group 1',
        sub: '⌘+1 works on a Mac. You can keep groups 1 to 9.',
        done: (c) => c.did.has('groupSave'),
      },
      {
        text: 'Click empty ground, then press 1',
        sub: 'Clicking the ground clears the selection. Pressing 1 brings group 1 back.',
        done: (c) => c.did.has('groupRecall') && c.sel.length >= 2,
      },
      {
        text: 'Right-click the strangers',
        sub: 'Right-click does the obvious thing: befriend strangers, teach a teammate, take over a rival building, or walk there.',
        done: (c) => c.did.has('rightClick') && befriending(c.w) >= 2,
        point: (c) => onBlob(nearestStranger(c.w), 'Right-click'),
      },
    ],
    outro: 'Also: Space pauses, H jumps home, Tab opens your team, + and − change speed.',
  },

  {
    id: 'crowd',
    icon: '👥',
    title: 'Make lots of friends',
    teaches: 'Groups · Befriending a crowd',
    view: [HX - 150, HY - 170, HX + 470, HY + 170],
    setup(w) {
      town(w, PLAYER);
      crowd(w, PLAYER, 6, HX, HY + 20, 75, CHARMING);
      crowd(w, NEUTRAL, 7, HX + 340, HY, 70, { openness: 0.7, allegiance: 0.25, violence: 0.15 });
    },
    steps: [
      {
        text: SELECT_GROUP,
        sub: SELECT_GROUP_SUB,
        done: (c) => c.sel.length >= 3 || befriending(c.w) >= 3,
        progress: (c) => ({ n: Math.min(3, c.sel.length), of: 3, label: 'selected' }),
      },
      {
        text: ['Tap one of the grey strangers', 'Right-click the crowd of strangers'],
        sub: 'Your group spreads out over the crowd, one stranger each.',
        done: (c) => befriending(c.w) >= 3 || converted(c) >= 3,
        point: (c) => onBlob(nearestStranger(c.w), 'Strangers'),
      },
      {
        text: 'Win over 5 strangers',
        sub: ['When a blob wins someone over, it moves on to the next one. If strangers wander off, tap them again.', 'When a blob wins someone over, it moves on to the next one. If strangers wander off, right-click them again.'],
        done: (c) => converted(c) >= 5,
        progress: (c) => ({ n: converted(c), of: 5, label: 'befriended' }),
      },
    ],
    outro: 'One tap, many friends. 👥 Team finds your most charming blobs for the job.',
  },

  {
    id: 'homes',
    icon: '🏠',
    title: 'Room for babies',
    teaches: 'Houses · Babies',
    build: ['house'],
    view: [HX - 230, HY - 200, HX + 230, HY + 200],
    setup(w) {
      town(w, PLAYER);
      // 11 blobs and the officer fill the town hall, so no babies until there's more room.
      for (const b of crowd(w, PLAYER, 11, HX, HY + 20, 110, { fertility: 0.92, violence: 0.1 }, 24)) b.breedCd = w.rng.range(2, 5);
      gold(w, 45);
    },
    steps: [
      {
        text: ['Your town is full. Tap 🏠 House, then tap inside your land', 'Your town is full. Press Q (🏠 House), then click inside your land'],
        sub: 'The 👥 number at the top is blobs / room. Babies need room, and each house adds 5.',
        done: (c) => me(c).counts.house > 0,
      },
      {
        text: 'Wait for 3 babies 🐣',
        sub: 'Social blobs (no job, no orders) have the most babies. Busy blobs have far fewer.',
        done: (c) => me(c).stats.births >= 3,
        progress: (c) => ({ n: me(c).stats.births, of: 3, label: 'babies' }),
      },
    ],
    outro: 'Houses give room; Social blobs fill it. Babies grow up in under a minute.',
  },

  {
    id: 'school',
    icon: '🏫',
    title: 'School days',
    teaches: 'Schools · Choosing what they teach',
    build: ['school'],
    view: [HX - 230, HY - 200, HX + 230, HY + 200],
    setup(w, m) {
      town(w, PLAYER);
      const all = [
        ...crowd(w, PLAYER, 5, HX, HY + 20, 90, { kindness: 0.3, violence: 0.2 }),
        ...crowd(w, PLAYER, 3, HX + 20, HY + 40, 50, { kindness: 0.25, violence: 0.2 }, 4),
      ];
      for (const b of all) m[`k${b.id}`] = b.traits.kindness;
      gold(w, 85);
    },
    steps: [
      {
        text: ['Tap 🏫 School, then tap near your blobs', 'Press W (🏫 School), then click near your blobs'],
        sub: 'Your blobs inside its circle learn its trait.',
        done: (c) => me(c).counts.school > 0,
      },
      {
        text: 'Make it teach 💗 Kindness',
        sub: ['Tap the school to open its panel. Each button says what that trait does.', 'Click the school to open its panel. Each button says what that trait does.'],
        done: (c) => c.w.buildings.some((b) => b.faction === PLAYER && b.kind === 'school' && b.focus === 'kindness'),
        point: (c) => onBuilding(c.w.buildings.find((b) => b.faction === PLAYER && b.kind === 'school'), 'Your school'),
      },
      {
        text: 'Watch your blobs get kinder',
        sub: 'They learn a little every second inside the circle. Kids learn twice as fast.',
        done: (c) => kindest(c) >= 10,
        progress: (c) => ({ n: kindest(c), of: 10, label: 'more kindness' }),
      },
    ],
    outro: 'Schools are slow but steady, and make blobs cleverer too. Teachers are faster: that’s next.',
  },

  {
    id: 'teach',
    icon: '🎓',
    title: 'Pass it on',
    teaches: 'Team · Teaching · Jobs',
    view: [HX - 230, HY - 190, HX + 230, HY + 190],
    setup(w, m) {
      town(w, PLAYER);
      const prof = add(w, PLAYER, HX - 60, HY + 50, { teaching: 0.95, kindness: 0.95, honesty: 0.9, patience: 0.85, intelligence: 0.8, violence: 0.04 });
      prof.name = 'Prof Plum';
      const grump = add(w, PLAYER, HX + 80, HY + 40, { violence: 0.9, kindness: 0.15, teaching: 0.2, patience: 0.6 });
      grump.name = 'Grumpo';
      for (const b of crowd(w, PLAYER, 4, HX, HY + 60, 90, { violence: 0.2 })) b.traits.teaching = w.rng.range(0.25, 0.55);
      m.prof = prof.id;
      m.grump = grump.id;
    },
    onEvent(e, c) {
      if (e.type === 'taught' && e.target === c.mem.grump) c.mem.taught = 1;
    },
    steps: [
      {
        text: ['Tap 👥 Team at the top', 'Press Tab (or click 👥 Team)'],
        sub: 'It ranks your blobs by what they’re good at.',
        done: (c) => c.did.has('team'),
      },
      {
        text: ['Open 📚 Teaching and tap Prof Plum', 'Open 📚 Teaching and click Prof Plum'],
        sub: 'Picking a name selects that blob.',
        done: (c) => c.sel.length === 1 && c.sel[0].id === c.mem.prof,
      },
      {
        text: ['Tap 📚 Teach, then tap Grumpo', 'Right-click Grumpo (or press C, then click)'],
        sub: 'Grumpo is a hot head 😠. Prof Plum passes on what it’s better at, and calms Grumpo down.',
        done: (c) => c.mem.taught === 1,
        progress: (c) => {
          const o = byId(c.w, c.mem.prof)?.order;
          return { n: o?.kind === 'teach' && o.target === c.mem.grump ? o.tries : 0, of: 8, label: 'lessons' };
        },
        point: (c) => onBlob(byId(c.w, c.mem.grump), 'Grumpo 😠'),
      },
      {
        text: ['Now make Prof Plum a 🎓 Teacher', 'Now make Prof Plum a 🎓 Teacher'],
        sub: 'Select Prof Plum and pick 🎓 Teacher in its Job row. Teachers keep teaching whoever is near, on their own.',
        done: (c) => byId(c.w, c.mem.prof)?.job === 'teacher',
        point: (c) => (c.sel.some((b) => b.id === c.mem.prof) ? [] : onBlob(byId(c.w, c.mem.prof), 'Prof Plum')),
      },
    ],
    outro: 'Find your stars with 👥 Team and give them jobs: 🎓 Teachers spread your best traits, 🌸 Recruiters befriend strangers.',
  },

  {
    id: 'fountain',
    icon: '⛲',
    title: 'Friendship Fountain',
    teaches: 'Fountains',
    build: ['fountain'],
    view: [HX - 150, HY - 190, HX + 480, HY + 190],
    setup(w) {
      town(w, PLAYER);
      crowd(w, PLAYER, 4, HX - 30, HY + 30, 60);
      crowd(w, NEUTRAL, 7, HX + 360, HY, 80, { openness: 0.75, allegiance: 0.2, violence: 0.15 });
      gold(w, 125);
    },
    onEvent(e, c) {
      if (e.type !== 'convert' || e.faction !== PLAYER) return;
      const r = FOUNTAIN_RADIUS + 15;
      if (c.w.buildings.some((f) => f.kind === 'fountain' && f.faction === PLAYER && dist2(f.x, f.y, e.x, e.y) < r * r)) {
        c.mem.fountain = (c.mem.fountain ?? 0) + 1;
      }
    },
    steps: [
      {
        text: [
          'Tap ⛲ Fountain, then tap the edge of your land nearest the strangers',
          'Press Y (⛲ Fountain), then click the edge of your land nearest the strangers',
        ],
        sub: 'Strangers who wander into its circle slowly warm to you.',
        done: (c) => me(c).counts.fountain > 0,
      },
      {
        text: 'Let 3 strangers come to you',
        sub: 'Strangers like visiting fountains. You don’t have to do a thing!',
        done: (c) => (c.mem.fountain ?? 0) >= 3,
        progress: (c) => ({ n: c.mem.fountain ?? 0, of: 3, label: 'befriended' }),
      },
    ],
    outro: 'Fountains befriend while you do other things. Put them where strangers wander.',
  },

  {
    id: 'takeover',
    icon: '🏳️',
    title: 'Take it over',
    teaches: 'Taking over buildings',
    view: [HX - 150, HY - 190, HX + 460, HY + 190],
    setup(w, m) {
      town(w, PLAYER);
      crowd(w, PLAYER, 7, HX - 20, HY + 20, 80, CHARMING);
      town(w, PINK, 1250, 330);
      const market = w.placeBuilding(PINK, 'market', HX + 330, HY + 10);
      const guard = add(w, PINK, market.x + 20, market.y + 30, { allegiance: 0.9, teaching: 0.2, kindness: 0.4, violence: 0.05 });
      guard.homeX = market.x;
      guard.homeY = market.y + 30;
      m.market = market.id;
    },
    steps: [
      {
        text: ['Select 3 or more blobs (👥 Select nearby)', 'Select 3 or more blobs (drag a box)'],
        sub: 'You need at least 3 to take over a building.',
        done: (c) => c.sel.length >= 3 || usurpers(c) >= 3,
        progress: (c) => ({ n: Math.min(3, c.sel.length), of: 3, label: 'selected' }),
      },
      {
        text: ['Tap the pink Market', 'Right-click the pink Market'],
        sub: ['Your blobs crowd around it.', 'Or press U, then click it. Your blobs crowd around it.'],
        done: (c) => usurpers(c) >= 3 || (bld(c.w, c.mem.market)?.faction ?? PLAYER) === PLAYER,
        point: (c) => onBuilding(bld(c.w, c.mem.market), 'Pink market'),
      },
      {
        text: 'Outnumber the pink blobs until the bar fills',
        sub: 'Blobs at home defend their buildings, and police count double.',
        done: (c) => bld(c.w, c.mem.market)?.faction === PLAYER,
        progress: (c) => {
          const b = bld(c.w, c.mem.market);
          return { n: Math.round(100 * (b?.faction === PLAYER ? 1 : b?.captureBy === PLAYER ? b.capture : 0)), of: 100, label: '% taken' };
        },
      },
    ],
    outro: 'No fighting needed! Lonely buildings are easiest. Watch out: rivals can take yours too.',
  },

  {
    id: 'police',
    icon: '🚓',
    title: 'Keep the peace',
    teaches: 'Police · Violence',
    build: ['police'],
    view: [HX - 200, HY - 200, HX + 420, HY + 200],
    setup(w) {
      town(w, PLAYER);
      crowd(w, PLAYER, 7, HX, HY + 20, 90, { honesty: 0.8, strength: 0.7, fitness: 0.7, violence: 0.1 });
      town(w, ORANGE, 1250, 330);
      gold(w, 150);
    },
    script(w, m) {
      if (!m.at) {
        // The bully turns up a few seconds after the station opens.
        if (w.factions[PLAYER].counts.police > 0) m.at = w.time + 5;
        return;
      }
      if (!m.bully && w.time >= m.at) {
        const b = add(w, ORANGE, HX + 400, HY - 90, { violence: 0.95, kindness: 0.05, fitness: 0.25, strength: 0.6, allegiance: 0.95 });
        b.name = 'Biff';
        m.bully = b.id;
      }
      const b = byId(w, m.bully);
      if (!b || !b.alive || b.jail > 0 || b.order.kind !== 'none') return;
      let best: Blob | null = null;
      let bd = Infinity;
      for (const t of mine(w)) {
        if (t.role === 'police' || t.jail > 0) continue;
        const d = dist2(b.x, b.y, t.x, t.y);
        if (d < bd) {
          bd = d;
          best = t;
        }
      }
      if (best) b.order = { kind: 'attack', target: best.id, hits: 0 };
    },
    onEvent(e, c) {
      if (e.type === 'arrest' && e.faction === PLAYER && e.blob === c.mem.bully) c.mem.caught = 1;
    },
    steps: [
      {
        text: ['Tap 🚓 Police, then tap inside your land', 'Press T (🚓 Police), then click inside your land'],
        sub: 'Each station adds 2 officers ⭐. Your most honest, strong blobs are picked.',
        done: (c) => me(c).counts.police > 0,
      },
      {
        text: 'A bully is coming! Watch your police',
        sub: 'Attackers become wanted 🚨. Your officers chase them anywhere in your land.',
        done: (c) => c.mem.caught === 1,
        point: (c) => onBlob(byId(c.w, c.mem.bully), 'Biff the bully'),
      },
    ],
    outro: 'Bonking (💥) steals gold, but police arrest anyone, even your own blobs, and other teams trust you less.',
  },

  {
    id: 'island',
    icon: '🌍',
    title: 'Unite the island',
    teaches: 'Everything together · Winning',
    size: [1500, 1500],
    victory: true,
    build: BUILD_MENU,
    view: [0, 200, 1500, 1300],
    setup(w) {
      town(w, PLAYER, 430, 840);
      crowd(w, PLAYER, 6, 430, 860, 80, CHARMING);
      town(w, PINK, 1120, 530);
      crowd(w, PINK, 6, 1120, 550, 70, { allegiance: 0.55 });
      crowd(w, NEUTRAL, 7, 900, 1020, 80, { openness: 0.65, allegiance: 0.3 });
      crowd(w, NEUTRAL, 7, 620, 460, 80, { openness: 0.65, allegiance: 0.3 });
      gold(w, 120);
    },
    steps: [
      {
        text: 'Lead 90% of all the blobs on the island',
        sub: 'Befriend strangers, win over the pink team, build what helps. Tip: make your charmers 🌸 Recruiters.',
        done: (c) => c.w.outcome?.winner === PLAYER,
        progress: (c) => {
          const total = c.w.blobs.length || 1;
          return { n: Math.round((100 * me(c).pop) / total), of: 90, label: '% of blobs' };
        },
      },
    ],
    outro: 'You’re ready for a real game. Good luck out there!',
  },
];

/** Most kindness any of the starting blobs has gained, in points out of 100. */
function kindest(c: TutCtx): number {
  let best = 0;
  for (const b of mine(c.w)) {
    const k0 = c.mem[`k${b.id}`];
    if (k0 !== undefined) best = Math.max(best, b.traits.kindness - k0);
  }
  return Math.floor(best * 100);
}

function usurpers(c: TutCtx): number {
  return mine(c.w).filter((b) => b.order.kind === 'usurp' && b.order.building === c.mem.market).length;
}

export function levelsFor(mode: ModeId): Level[] {
  return LEVELS.filter((l) => !l.only || l.only === mode);
}

export function findLevel(mode: ModeId, id: string): Level | undefined {
  return levelsFor(mode).find((l) => l.id === id);
}

// ───────────────────────────── runner ─────────────────────────────

/** Tracks which step of a level you're on. Pure logic, so tests can drive it. */
export class TutorialRun {
  step = 0;
  done = false;
  readonly mem: Record<string, number> = {};
  readonly did = new Set<UiDid>();
  constructor(readonly level: Level) {}

  worldOptions(): WorldOptions {
    return {
      size: this.level.size ?? SIZE,
      ai: false,
      victory: !!this.level.victory,
      scenario: (w) => this.level.setup(w, this.mem),
    };
  }

  current(): Step | null {
    return this.done ? null : this.level.steps[this.step];
  }

  /** Call once a frame. Returns true if the step changed. */
  update(w: World, sel: readonly Blob[], events: readonly SimEvent[]): boolean {
    if (this.done) return false;
    const c: TutCtx = { w, sel, did: this.did, mem: this.mem, events };
    if (this.level.onEvent) for (const e of events) this.level.onEvent(e, c);
    this.level.script?.(w, this.mem);
    let changed = false;
    while (!this.done && this.level.steps[this.step].done(c)) {
      changed = true;
      this.step++;
      if (this.step >= this.level.steps.length) this.done = true;
    }
    return changed;
  }

  points(w: World, sel: readonly Blob[]): readonly Pointer[] {
    const s = this.current();
    return s?.point?.({ w, sel, did: this.did, mem: this.mem, events: [] }) ?? [];
  }

  progress(w: World, sel: readonly Blob[]): Progress | null {
    const s = this.current();
    if (!s?.progress) return null;
    return s.progress({ w, sel, did: this.did, mem: this.mem, events: [] });
  }
}
