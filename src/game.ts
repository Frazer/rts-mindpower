import { sound } from './audio';
import { Coach, coached, markCoached } from './coach';
import type { ModeConfig } from './modes';
import { platform } from './platform';
import { completed } from './progress';
import { GameRenderer } from './render/renderer';
import { Lockstep } from './net/lockstep';
import type { ClientMsg, Setup, Turn } from './net/protocol';
import { ADULT_AGE, BUILD_MENU, BUILDINGS, DT, MAX_LEVEL, PLAYER, buildCost, upgradeCost } from './sim/config';
import type { TraitKey } from './sim/traits';
import { lessonValue } from './sim/systems/jobs';
import type { Blob, Building, BuildingKind, Command, Job, OrderCommand, SimEvent } from './sim/types';
import type { MapId, MapSize } from './sim/maps';
import { World } from './sim/world';
import { TutorialRun, levelsFor, say, type Level } from './tutorials';
import { Hud, JOBS, type CommandMode, type PanelAction, type TeamAct, type TeamTab } from './ui/hud';
import { ALL_FEATURES, nextUnlock, unlock, unlocked, type Feature } from './unlocks';

interface PointerInfo {
  x: number;
  y: number;
  sx: number;
  sy: number;
  button: number;
  mouse: boolean;
}

type Drag = 'none' | 'pan' | 'box' | 'pinch';

const BUILD_HOTKEYS: Record<string, BuildingKind> = { q: 'house', w: 'school', e: 'lab', r: 'market', t: 'police', y: 'fountain' };
/** Radius of the crowd a group befriend aims at. */
const AREA_R = 150;
/** Casual: a tap this close to a stranger (CSS px) counts as tapping them, since they wander. */
const MISS_PX = 70;
const NO_FEATURES: ReadonlySet<Feature> = new Set();
/** "Around this blob": Select nearby and a double tap pick your blobs this close. */
const NEAR = 260;
/** Rewarded ad: gold you get, and game-seconds before the next offer. */
const GIFT_GOLD = 75;
const GIFT_FIRST = 45;
const GIFT_COOLDOWN = 180;

export interface TutorialCallbacks {
  level: Level;
  next: Level | null;
  /** The level was finished (save progress). */
  done(): void;
  onNext(): void;
  onList(): void;
  /** Start a real game. */
  onPlay(): void;
}

export interface GameCallbacks {
  onMenu(): void;
  onRestart(): void;
  tutorial?: TutorialCallbacks;
}

/** An online game: the relay's setup, and a way to talk to it. */
export interface OnlineOptions {
  setup: Setup;
  /** Your team. */
  team: number;
  speed: number;
  paused: boolean;
  /** Rejoining a game already under way: wait for a copy of it. */
  resume: boolean;
  send(m: ClientMsg): void;
  isHost(): boolean;
}

/** Owns the loop and turns input into sim commands. */
/** News that comes in bursts shows as one line with a running count. */
const BURSTS = {
  joined: (n: number) => `💗 ${n} blobs joined you!`,
  lost: (n: number) => `💔 ${n} blobs were won over`,
  gaveIn: (n: number) => `😨 ${n} blobs gave in out of fear`,
  scared: (n: number) => `😨 ${n} blobs were scared away`,
  wandered: (n: number) => `💨 ${n} blobs left to wander`,
  knockedOut: (n: number) => `👻 ${n} blobs were knocked out for good`,
  arrested: (n: number) => `🚨 ${n} of your blobs were arrested`,
  ourArrests: (n: number) => `🚓 Your police arrested ${n} blobs`,
  recruits: (n: number) => `⭐ ${n} blobs joined your police`,
};

export class Game {
  private selected = new Set<number>();
  private pickedBuilding: number | null = null;
  /** Every one of your buildings of this kind is picked (selBuilding is the one you started from). */
  private selKind: BuildingKind | null = null;
  /** Last tap on one of your buildings, to spot a double tap. */
  private lastBuildingTap = { id: -1, at: 0 };
  /** Last tap on one of your blobs, to spot a double tap (it may have walked a little since). */
  private lastBlobTap = { id: -1, x: 0, y: 0, at: 0 };
  private buildMode: BuildingKind | null = null;
  private command: CommandMode = null;
  /** The player switched on the buildings view (it also comes on by itself when aiming at buildings). */
  private buildingView = false;
  private team: TeamTab | null = null;
  private speed: number;
  private paused = false;
  private acc = 0;
  private last = performance.now();
  private hudTimer = 0;
  private miniTimer = 0;
  private hover: { x: number; y: number } | null = null;
  private readonly pointers = new Map<number, PointerInfo>();
  private drag: Drag = 'none';
  private pinch = { d: 0, mx: 0, my: 0 };
  private suppressTap = false;
  private readonly keys = new Set<string>();
  private readonly groups = new Map<string, number[]>();
  private readonly throttle = new Map<string, number>();
  private warnedViolence = false;
  /** When the level-complete card should appear (a beat after the last step, so you see it land). */
  private tutDoneAt = 0;
  /** An ad is playing: the sim and input wait. */
  private adHold = false;
  private destroyed = false;
  private nextGift = GIFT_FIRST;
  private endSound = false;
  private readonly cleanup: (() => void)[] = [];

  /** Your team. */
  private readonly me: number;
  private readonly net: { opts: OnlineOptions; ls: Lockstep } | null;
  /** Told the player their last blob is gone (online, where the game goes on without them). */
  private toldOut = false;
  /** A new player's first game: points out their first befriend, step by step. */
  private coach: Coach | null = null;
  private coachStep = -1;
  /** You've won someone over this game (brings in the first new buttons). */
  private madeFriend = false;
  /** Space out the "new button" messages. */
  private nextIntroAt = 0;

  private constructor(
    private readonly mode: ModeConfig,
    private readonly world: World,
    private readonly r: GameRenderer,
    private readonly hud: Hud,
    private readonly tut: TutorialRun | null,
    private readonly tutCb: TutorialCallbacks | null,
    online: OnlineOptions | null,
  ) {
    this.speed = mode.defaultSpeed;
    this.me = online?.team ?? PLAYER;
    hud.me = this.me;
    if (online) {
      this.speed = online.speed;
      this.paused = online.paused;
      const ls = new Lockstep(
        world,
        {
          hash: (n, h) => online.send({ t: 'hash', n, h }),
          snap: (n, data) => online.send({ t: 'snap', n, data }),
        },
        online.resume,
      );
      this.net = { opts: online, ls };
      // A hidden tab gets no animation frames, but should keep up so it doesn't fall far behind.
      const bg = setInterval(() => this.catchUpWithoutFrames(), 500);
      this.cleanup.push(() => clearInterval(bg));
    } else {
      this.net = null;
    }
  }

  static async start(
    mode: ModeConfig,
    host: HTMLElement,
    hudRoot: HTMLElement,
    cb: GameCallbacks,
    seed = Date.now(),
    setup: { rivals?: number; map?: MapId; mapSize?: MapSize } = {},
    online?: OnlineOptions,
  ): Promise<Game> {
    const tut = cb.tutorial ? new TutorialRun(cb.tutorial.level) : null;
    const o = online?.setup;
    const world = o
      ? new World(mode, o.seed, { rivals: o.rivals, map: o.map, mapSize: o.size, humans: o.humans, names: o.names })
      : new World(mode, seed, tut?.worldOptions() ?? setup);
    const r = await GameRenderer.create(host, world);
    let game: Game | null = null;
    const hud = new Hud(hudRoot, mode, {
      build: (k) => game?.toggleBuild(k),
      action: (a) => game?.panelAction(a),
      focus: (t) => game?.setFocus(t),
      speed: (s) => game?.setSpeed(s),
      pause: () => game?.togglePause(),
      menu: cb.onMenu,
      restart: cb.onRestart,
      minimap: (fx, fy) => game?.jumpTo(fx * world.w, fy * world.h),
      job: (j) => game?.setJob(j),
      team: (t) => game?.setTeam(t),
      teamPick: (id) => game?.teamPick(id),
      teamAct: (a, ids) => game?.teamAct(a, ids),
      sound: () => sound.toggle(),
      buildingView: () => game?.toggleBuildingView(),
      gift: () => void game?.watchAd(),
    });
    game = new Game(mode, world, r, hud, tut, cb.tutorial ?? null, online ?? null);
    game.init();
    return game;
  }

  private init(): void {
    const hall = this.world.hall(this.me)!;
    const cam = this.r.camera;
    cam.x = hall.x;
    cam.y = hall.y;
    cam.zoom = this.mode.id === 'casual' ? 1.05 : 0.9;
    this.bindInput();
    this.r.app.ticker.add(this.frame);
    if (this.tut) {
      this.hud.setTutorial(!!this.tut.level.victory, this.tut.level.build ?? []);
      this.hud.tutorial(this.tutCard());
      this.frameView(this.tut.level.view);
      return;
    }
    // Finishing every Casual tutorial counts as having met every button.
    if (this.mode.id === 'casual' && levelsFor('casual').every((l) => completed('casual').has(l.id))) unlock(ALL_FEATURES);
    if (!coached()) {
      this.coach = new Coach(this.me, this.mode.id);
      this.updateCoach([], performance.now());
      return;
    }
    this.hud.say(
      this.mode.id === 'casual'
        ? '👋 Tap one of your blue blobs, then tap a stranger to befriend them! 👥 Team finds your best blobs.'
        : '👋 Box-select blobs, right-click a crowd to befriend it. Right-click a rival building to take it over. Tab = team.',
      'info',
    );
  }

  /** Fit a world rectangle into the part of the screen the HUD leaves clear. */
  private frameView([x0, y0, x1, y1]: readonly [number, number, number, number]): void {
    const cam = this.r.camera;
    const { width, height } = this.r.app.screen;
    cam.resize(width, height);
    const a = this.hud.freeArea();
    // Never so small that blobs are hard to tap; then the edges just spill over.
    const zoom = Math.max(cam.minZoom, 0.6, Math.min(1.25, (a.x1 - a.x0) / (x1 - x0), (a.y1 - a.y0) / (y1 - y0)));
    cam.zoom = zoom;
    this.jumpTo((x0 + x1) / 2, (y0 + y1) / 2);
  }

  private tutCard() {
    const t = this.tut!;
    const s = t.current();
    const m = this.mode.id;
    if (!s) {
      const n = t.level.steps.length;
      return { icon: t.level.icon, title: t.level.title, step: n, steps: n, text: '✅ Nice!', sub: '', progress: null };
    }
    return {
      icon: t.level.icon,
      title: t.level.title,
      step: t.step,
      steps: t.level.steps.length,
      text: say(s.text, m),
      sub: s.sub ? say(s.sub, m) : '',
      progress: t.progress(this.world, this.ownSelected()),
    };
  }

  private updateTutorial(events: readonly SimEvent[], now: number): void {
    const t = this.tut;
    if (!t) return;
    if (t.done) {
      if (this.tutDoneAt && now >= this.tutDoneAt) {
        this.tutDoneAt = 0;
        this.finishTutorial();
      }
      return;
    }
    if (!t.update(this.world, this.ownSelected(), events)) return;
    this.hud.tutorial(this.tutCard());
    sound.play(t.done ? 'win' : 'step');
    if (t.done) {
      this.tutDoneAt = now + 1300;
      platform.happyTime();
    } else {
      this.showTarget();
    }
  }

  /**
   * On small screens a new step's target can sit under the selection panel or the
   * tutorial card (the step that says "tap the stranger" starts as the panel opens),
   * so bring it into the clear part of the screen.
   */
  private showTarget(): void {
    const p = this.tut!.points(this.world, this.ownSelected())[0];
    if (!p) return;
    const a = this.hud.freeArea();
    const s = this.r.camera.toScreen(p.x, p.y);
    // The label sits above the point, the blob or building just below it.
    const clear = s.x >= a.x0 + 40 && s.x <= a.x1 - 40 && s.y >= a.y0 + 40 && s.y <= a.y1 - 40;
    if (!clear) this.jumpTo(p.x, p.y);
  }

  private finishTutorial(): void {
    const t = this.tut!;
    const cb = this.tutCb!;
    cb.done();
    this.buildMode = null;
    this.command = null;
    this.team = null;
    this.selected.clear();
    this.selBuilding = null;
    this.hud.tutorialDone({
      icon: t.level.icon,
      title: t.level.title,
      outro: say(t.level.outro, this.mode.id),
      next: cb.next ? { icon: cb.next.icon, title: cb.next.title } : null,
      onNext: cb.onNext,
      onList: cb.onList,
      onPlay: cb.onPlay,
    });
  }

  destroy(): void {
    this.destroyed = true;
    platform.setPlaying(false);
    this.r.app.ticker.remove(this.frame);
    for (const c of this.cleanup) c();
    this.hud.destroy();
    this.r.destroy();
  }

  // ───────────────────────────── loop ─────────────────────────────

  private readonly frame = (): void => {
    const now = performance.now();
    const dt = Math.min(0.1, (now - this.last) / 1000);
    this.last = now;
    const w = this.world;

    let alpha = this.paused ? 1 : this.acc / DT;
    if (this.net) {
      alpha = this.playTurns(dt);
    } else if (!this.paused && !w.outcome && !this.adHold) {
      this.acc += dt * this.speed;
      let steps = 0;
      while (this.acc >= DT && steps < 10) {
        w.tick(DT);
        this.acc -= DT;
        steps++;
      }
      if (steps === 10) this.acc = 0;
      alpha = this.acc / DT;
    }

    this.keyboardPan(dt);
    const events = w.drainEvents();
    this.r.fx(events);
    this.narrate(events);
    this.updateTutorial(events, now);
    this.updateCoach(events, now);

    for (const id of this.selected) if (!w.byId.has(id)) this.selected.delete(id);

    if (this.buildMode && this.hover) {
      const ok = w.canPlace(this.me, this.buildMode, this.hover.x, this.hover.y).ok;
      this.r.setGhost(this.buildMode, this.hover.x, this.hover.y, ok, w.factions[this.me].color);
    } else {
      this.r.setGhost(null);
    }

    const group = this.pickedGroup();
    this.r.render(alpha, now, dt, this.selected, this.selBuilding, this.buildMode ? this.me : -1, this.buildingsOnly, group ? new Set(group.map((b) => b.id)) : null);
    if (this.tut) {
      const pts = this.tut.done ? [] : this.tut.points(w, this.ownSelected());
      this.hud.points(pts.map((p) => ({ ...this.r.camera.toScreen(p.x, p.y), label: p.label })));
    } else if (this.coach) {
      const pts = this.coach.points(w, this.ownSelected());
      this.hud.points(pts.map((p) => ({ ...this.r.camera.toScreen(p.x, p.y), label: p.label })));
    }

    this.hudTimer -= dt;
    if (this.hudTimer <= 0) {
      this.hudTimer = 0.2;
      this.checkUnlocks(now);
      this.hud.update(w, this.hudState());
      const [hint, sub] = this.hintText();
      this.hud.hint(hint, sub);
      if (this.tut && !this.tut.done) this.hud.tutorial(this.tutCard()); // progress bars
    }
    this.miniTimer -= dt;
    if (this.miniTimer <= 0) {
      this.miniTimer = 0.25;
      this.hud.drawMinimap(w, this.r.camera.view());
    }
    if (w.outcome && !(this.tut?.done && w.outcome.winner === this.me)) this.hud.showEnd(w);
    if (w.outcome && !this.endSound) {
      this.endSound = true;
      const won = w.outcome.winner === this.me;
      if (!this.tut) sound.play(won ? 'win' : 'lose');
      if (won) platform.happyTime();
    }
    platform.setPlaying(!this.paused && !w.outcome && !this.adHold && !this.tut?.done);
  };

  /**
   * Online: play the relay's turns as they arrive, at the pace they arrive. Behind (a slow
   * frame, a hidden tab, an ad) means play faster until caught up. Returns the drawing blend.
   */
  private playTurns(dt: number): number {
    const ls = this.net!.ls;
    if (this.adHold) return 1;
    const behind = ls.backlog;
    this.acc += dt * (behind > 30 ? 30 : behind > 3 ? 2 : 1);
    for (let i = 0; i < 600; i++) {
      const cost = ls.tickCost();
      if (this.acc < cost) break;
      if (ls.step(1) === 0) {
        // Waiting for the next turn: hold at most one tick's worth of time.
        this.acc = Math.min(this.acc, cost);
        break;
      }
      this.acc -= cost;
    }
    const w = this.world;
    if (!this.toldOut && !w.outcome && w.factions[this.me]?.pop === 0 && w.time > 5) {
      this.toldOut = true;
      this.hud.say('😢 All your blobs are gone. You can keep watching the others.', 'bad');
    }
    return Math.min(1, this.acc / ls.tickCost());
  }

  /**
   * Hidden or background tabs get no animation frames (some browsers don't even mark them
   * hidden). Keep playing turns anyway, so the game is current when the player looks again
   * and the host can still hand out copies of it.
   */
  private catchUpWithoutFrames(): void {
    if (!this.net || this.adHold || this.destroyed) return;
    if (!document.hidden && performance.now() - this.last < 400) return;
    this.net.ls.step(4000);
    this.world.drainEvents();
  }

  /** Online messages for the running game. */
  onTurn(t: Turn): void {
    this.net?.ls.add(t);
    this.catchUpWithoutFrames();
  }

  onSnap(n: number, data: string, turns: readonly Turn[]): void {
    this.net?.ls.load(n, data, turns);
    this.acc = 0;
  }

  onSnapRequest(): void {
    this.net?.ls.requestSnap();
  }

  onPace(speed: number, paused: boolean): void {
    this.speed = speed;
    this.paused = paused;
  }

  /** Someone has won. */
  get ended(): boolean {
    return !!this.world.outcome;
  }

  /** A short message on screen. */
  notice(text: string): void {
    this.hud.toast(text, 'info');
  }

  /** Like notice, for something the player has to read. */
  say(text: string): void {
    this.hud.say(text, 'info');
  }

  /** Orders go straight into the game, or online to the relay, which puts them in the next turn for everyone. */
  private send(c: Command): void {
    if (this.net) this.net.opts.send({ t: 'cmd', c });
    else this.world.command(c);
  }

  /** Pause everything and ignore input while an ad is requested or playing (the platform calls this). */
  setAdHold(on: boolean): void {
    this.adHold = on;
    if (on) {
      this.keys.clear();
      this.pointers.clear();
      this.drag = 'none';
      this.r.setBox(null);
    }
  }

  /** Seconds until the rewarded-ad offer is ready, or null when it isn't offered (no ads, or the portal forbids it during play). */
  private giftState(): number | null {
    if (!platform.rewardedInPlay || this.tut || this.net || this.world.outcome) return null;
    return Math.max(0, this.nextGift - this.world.time);
  }

  /** Rewarded ad: the player chose to watch one for some gold. */
  private async watchAd(): Promise<void> {
    if (this.giftState() !== 0 || this.adHold) return;
    const ok = await platform.rewardedBreak();
    if (this.destroyed) return;
    const w = this.world;
    if (!ok) {
      this.nextGift = w.time + 20;
      this.hud.say('📺 No ad to show right now. Try again soon.', 'info');
      return;
    }
    this.send({ type: 'gift', faction: this.me, gold: GIFT_GOLD });
    this.nextGift = w.time + GIFT_COOLDOWN;
    this.hud.say(`🎁 +${GIFT_GOLD} gold. Thanks for watching!`, 'good');
    sound.play('coin');
  }

  private hudState() {
    const blobs = [...this.selected].map((id) => this.world.byId.get(id)).filter((b): b is Blob => !!b);
    const building = this.selBuilding !== null ? (this.world.buildings.find((b) => b.id === this.selBuilding) ?? null) : null;
    return {
      selected: blobs,
      building,
      group: this.pickedGroup(),
      buildMode: this.buildMode,
      command: this.command,
      buildingView: this.buildingView,
      speed: this.speed,
      paused: this.paused,
      team: this.team,
      muted: sound.isMuted,
      gift: this.giftState() === null ? null : { ready: this.giftState() === 0, gold: GIFT_GOLD },
      hide: this.hiddenFeatures(),
    };
  }

  /** Buttons a new Casual player hasn't met yet (Pro and the tutorials show everything). */
  private hiddenFeatures(): ReadonlySet<Feature> {
    if (this.mode.id !== 'casual' || this.tut) return NO_FEATURES;
    const have = unlocked();
    return have.size === ALL_FEATURES.length ? NO_FEATURES : new Set(ALL_FEATURES.filter((f) => !have.has(f)));
  }

  /** Bring in the next few buttons once the player is ready for them, with a word on each. */
  private checkUnlocks(now: number): void {
    if (this.mode.id !== 'casual' || this.tut || this.coach || this.world.outcome || now < this.nextIntroAt) return;
    const u = nextUnlock();
    const f = this.world.factions[this.me];
    if (!u || !u.ready({ time: this.world.time, madeFriend: this.madeFriend, hasSchool: f.counts.school > 0 })) return;
    unlock(u.features);
    this.hud.say(u.intro, 'good');
    sound.play('step');
    this.nextIntroAt = now + 8000;
  }

  private updateCoach(events: readonly SimEvent[], now: number): void {
    const c = this.coach;
    if (!c) return;
    if (events.some((e) => e.type === 'convert' && e.faction === this.me)) {
      this.coach = null;
      markCoached();
      this.hud.tutorial(null);
      this.hud.points([]);
      sound.play('step');
      this.hud.say(`🎉 Your first new friend! Keep going: lead ${Math.round(this.mode.winShare * 100)}% of all the blobs to win.`, 'good');
      this.nextIntroAt = now + 6000;
      return;
    }
    const sel = this.ownSelected();
    const n = c.step(this.world, sel);
    if (n === this.coachStep) return;
    const forward = n > this.coachStep;
    this.coachStep = n;
    this.hud.tutorial(c.card(this.world, sel));
    if (n > 0 && forward) sound.play('step');
    if (n === 1) this.showCoachTarget(sel);
  }

  /**
   * If the strangers are hidden (off screen, or under the panel or the steps card), swing the
   * camera: to show your blob and the strangers together if the clear part of the screen is
   * big enough, else just the strangers.
   */
  private showCoachTarget(sel: readonly Blob[]): void {
    const p = this.coach?.points(this.world, sel)[0];
    if (!p) return;
    const a = this.hud.freeArea();
    const s = this.r.camera.toScreen(p.x, p.y);
    if (s.x >= a.x0 + 40 && s.x <= a.x1 - 40 && s.y >= a.y0 + 40 && s.y <= a.y1 - 40) return;
    const b = sel[0];
    const z = this.r.camera.zoom;
    const both = b && Math.abs(p.x - b.x) * z <= a.x1 - a.x0 - 80 && Math.abs(p.y - b.y) * z <= a.y1 - a.y0 - 60;
    if (both) this.jumpTo((b.x + p.x) / 2, (b.y + p.y) / 2);
    else this.jumpTo(p.x, p.y);
  }

  private hintText(): [string | null, string?] {
    const tap = this.mode.id === 'casual' ? 'Tap' : 'Click';
    if (this.buildMode) {
      const d = BUILDINGS[this.buildMode];
      const keys = this.mode.hotkeys ? ' · Shift keeps building, Esc cancels' : '';
      return [`${d.icon} ${tap} inside your land to place the ${d.label}`, d.desc + keys];
    }
    if (this.command === 'befriend') {
      return [`💗 ${tap} a stranger or a crowd to befriend`, 'Your blobs spread out and befriend everyone there, one by one. Charming, kind, honest blobs are fastest.'];
    }
    if (this.command === 'usurp') {
      return [`🏳️ ${tap} a building from another team`, 'Your blobs stand around it. If they outnumber the blobs there, it slowly becomes yours. No fighting needed.'];
    }
    if (this.command === 'attack') return [`💥 ${tap} a blob to bonk`, 'Steals gold, but police may arrest you and others will trust you less.'];
    if (this.command === 'teach') {
      const t = this.ownSelected()[0];
      return [`📚 ${tap} one of your own blobs to teach`, `${t ? t.name : 'Your blob'} passes on whatever it's better at (and calms hot heads).`];
    }
    if (this.command === 'move') return [`🚶 ${tap} where to walk`];
    if (this.paused) return ['Paused'];
    if (this.buildingView) {
      const own = this.ownSelected().length;
      return [
        '🏘️ Buildings view: blobs are out of the way',
        own
          ? `${tap} a rival building and your ${own > 1 ? `${own} blobs go` : 'blob goes'} to take it over.`
          : `${tap} any building to open it. ${this.mode.hotkeys ? 'B' : 'The 🏘️ button'} brings your blobs back.`,
      ];
    }
    return [null];
  }

  // ───────────────────────────── narration ─────────────────────────────

  private once(key: string, seconds: number): boolean {
    const t = this.world.time;
    const last = this.throttle.get(key) ?? -Infinity;
    if (t - last < seconds) return false;
    this.throttle.set(key, t);
    return true;
  }

  private narrate(events: readonly SimEvent[]): void {
    const w = this.world;
    const name = (f: number): string => (f === this.me ? 'you' : (w.factions[f]?.name ?? '?'));
    const color = (f: number): number => w.factions[f]?.color ?? 0x999999;
    for (const e of events) {
      switch (e.type) {
        case 'convert':
          if (e.faction === this.me) sound.play('befriend');
          else if (e.other === this.me) sound.play('lost');
          if (e.faction === this.me) {
            this.madeFriend = true;
            this.hud.toast(`💗 ${e.text} joined you!`, 'good', BURSTS.joined);
            // Not while the first-steps guide or a new button is having its say.
            if (!this.tut && !this.coach && performance.now() >= this.nextIntroAt && this.once('tipTeach', Infinity)) {
              this.hud.say('📚 Tip: select a charming blob and press Teach to pass its best traits to a teammate.', 'info');
              this.nextIntroAt = performance.now() + 8000;
            }
          }
          else if (e.other === this.me) this.hud.toast(`💔 ${e.text} was won over by ${name(e.faction)}`, 'bad', BURSTS.lost);
          this.hud.log(`${e.text}: ${w.factions[e.other].name} → ${w.factions[e.faction].name}`, color(e.faction));
          break;
        case 'fearConvert':
          if (e.faction === this.me || e.other === this.me) sound.play(e.faction === this.me ? 'befriend' : 'lost');
          if (e.faction === this.me) this.hud.toast(`😨 ${e.text} gave in out of fear (shaky loyalty)`, 'info', BURSTS.gaveIn);
          else if (e.other === this.me) this.hud.toast(`😨 ${e.text} was scared into joining ${name(e.faction)}`, 'bad', BURSTS.scared);
          this.hud.log(`${e.text} scared into ${w.factions[e.faction].name}`, color(e.faction));
          break;
        case 'defect':
          if (e.other === this.me) this.hud.toast(`💨 ${e.text} left to wander`, 'bad', BURSTS.wandered);
          break;
        case 'hit':
          if (e.faction === this.me || e.other === this.me) sound.play('bonk');
          if (e.other === this.me && this.once('hurt', 6)) this.hud.toast(`💥 ${e.text} is attacking your blobs!`, 'bad');
          if (e.faction === this.me && this.once('violent', 8)) this.hud.toast(`💥 ${e.text} turned violent — now wanted 🚨`, 'bad');
          if (this.once(`hitlog${e.blob}`, 5)) this.hud.log(`${e.text} attacked a ${w.factions[e.other].name} blob`, color(e.faction));
          break;
        case 'kill':
          if (e.other === this.me) this.hud.toast(`👻 ${e.text} was knocked out for good`, 'bad', BURSTS.knockedOut);
          this.hud.log(`${e.text} (${w.factions[e.other].name}) was killed`, color(e.faction));
          break;
        case 'arrest':
          if (e.faction === this.me || e.other === this.me) sound.play('arrest');
          if (e.other === this.me) this.hud.toast(`🚨 ${e.text} was arrested`, 'bad', BURSTS.arrested);
          else if (e.faction === this.me) this.hud.toast(`🚓 Your police arrested ${e.text}`, 'good', BURSTS.ourArrests);
          this.hud.log(`${e.text} arrested by ${w.factions[e.faction].name} police`, color(e.faction));
          break;
        case 'tech':
          if (e.faction === this.me) sound.play('tech');
          if (e.faction === this.me) this.hud.toast(`💡 ${e.text}! Smarter police & better persuasion`, 'good');
          this.hud.log(`${w.factions[e.faction].name} reached ${e.text}`, color(e.faction));
          break;
        case 'recruit':
          if (e.faction === this.me) this.hud.toast(`⭐ ${e.text} joined your police`, 'info', BURSTS.recruits);
          break;
        case 'build':
          if (e.faction === this.me) sound.play('build');
          if (e.faction !== this.me && e.faction >= 0) this.hud.log(`${w.factions[e.faction].name} built a ${e.text}`, color(e.faction));
          if (e.faction === this.me && w.buildings.find((b) => b.id === e.target)?.kind === 'school') {
            this.selected.clear();
            this.selBuilding = e.target;
            this.hud.say('🏫 Pick what your school teaches. Your blobs inside the circle learn it.', 'info');
          }
          break;
        case 'upgrade':
          if (e.faction === this.me) sound.play('tech');
          else if (e.faction >= 0) this.hud.log(`${w.factions[e.faction].name} upgraded a ${e.text}`, color(e.faction));
          break;
        case 'taught':
          if (e.faction === this.me && e.manual) this.hud.toast(`📚 ${e.text}`, 'good');
          else if (e.faction === this.me && this.once('jobLesson', 20)) this.hud.log(`📚 ${e.text}`, color(e.faction));
          break;
        case 'usurping':
          if (e.other === this.me && this.once(`usurping${e.target}`, 15)) {
            this.hud.say(`🏳️ ${w.factions[e.faction].name} are taking over your ${e.text}! Send blobs to stand there.`, 'bad');
          }
          this.hud.log(`${w.factions[e.faction].name} started taking over a ${w.factions[e.other].name} ${e.text}`, color(e.faction));
          break;
        case 'usurp':
          if (e.faction === this.me) sound.play('takeover');
          else if (e.other === this.me) sound.play('lostBuilding');
          if (e.faction === this.me) this.hud.toast(`🏳️ You took over the ${e.text}!`, 'good');
          else if (e.other === this.me) this.hud.toast(`😱 ${w.factions[e.faction].name} took your ${e.text}`, 'bad');
          this.hud.log(`${w.factions[e.faction].name} took a ${w.factions[e.other].name} ${e.text}`, color(e.faction));
          break;
        case 'notice':
          if (e.faction === this.me) this.hud.toast(e.text, 'info');
          break;
        case 'birth':
          if (e.faction === this.me) sound.play('birth');
          break;
        default:
          break;
      }
    }
  }

  // ───────────────────────────── actions ─────────────────────────────

  private get selBuilding(): number | null {
    return this.pickedBuilding;
  }

  /** Picking a building, or none, drops a pick of all of a kind. */
  private set selBuilding(id: number | null) {
    this.pickedBuilding = id;
    this.selKind = null;
  }

  /** Your buildings of the picked kind, or null when there's no such pick. */
  private pickedGroup(): Building[] | null {
    if (!this.selKind) return null;
    const list = this.world.buildings.filter((b) => b.faction === this.me && b.kind === this.selKind);
    if (!list.length) {
      this.selBuilding = null;
      return null;
    }
    return list;
  }

  private selectKind(b: Building): void {
    this.selected.clear();
    this.team = null;
    this.selBuilding = b.id;
    this.selKind = b.kind;
    sound.play('select');
  }

  private ownSelected(): Blob[] {
    return [...this.selected]
      .map((id) => this.world.byId.get(id))
      .filter((b): b is Blob => !!b && this.world.commandable(b, this.me));
  }

  /** While this is true blobs fade out and clicks go straight through them to the buildings. */
  private get buildingsOnly(): boolean {
    return this.buildingView || this.buildMode !== null || this.command === 'usurp';
  }

  private toggleBuildingView(): void {
    this.buildingView = !this.buildingView;
  }

  private toggleBuild(kind: BuildingKind): void {
    if (this.tut && !(this.tut.level.build ?? []).includes(kind)) return;
    this.command = null;
    const me = this.world.factions[this.me];
    const cost = buildCost(me, kind);
    if (this.buildMode !== kind && me.gold < cost) {
      const d = BUILDINGS[kind];
      this.hud.say(`${d.icon} ${d.label} needs ${cost} gold (you have ${Math.floor(me.gold)}). Gold builds up over time.`, 'info');
      sound.play('error');
      return;
    }
    this.buildMode = this.buildMode === kind ? null : kind;
    if (this.buildMode && this.mode.id === 'casual') {
      const hall = this.world.hall(this.me);
      if (hall) this.hover = { x: hall.x, y: hall.y };
    }
  }

  private panelAction(a: PanelAction): void {
    const own = this.ownSelected();
    const other = [...this.selected].map((id) => this.world.byId.get(id)).find((b) => b && b.faction !== this.me);
    switch (a) {
      case 'deselect':
        this.selected.clear();
        this.command = null;
        return;
      case 'befriend':
      case 'attack':
      case 'teach':
      case 'usurp':
      case 'move':
        if (!own.length) return;
        this.buildMode = null;
        this.command = this.command === a ? null : a;
        if (a === 'attack') this.violenceWarning();
        return;
      case 'stop':
        this.order('stop');
        return;
      case 'upgrade':
        if (this.selKind) this.levelUpAll();
        else this.levelUp();
        return;
      case 'upgradeAll':
        this.levelUpAll();
        return;
      case 'selectKind': {
        const b = this.world.buildings.find((x) => x.id === this.selBuilding);
        if (b && b.faction === this.me) this.selectKind(b);
        return;
      }
      case 'sendFriend':
        if (other) this.send({ type: 'autoBefriend', faction: this.me, target: other.id, count: 3 });
        return;
      case 'sendUsurp':
        if (this.selBuilding !== null) this.send({ type: 'autoUsurp', faction: this.me, building: this.selBuilding, count: 5 });
        return;
      case 'nearby':
        if (own[0]) this.selectNear(own[0]);
        return;
      case 'sendBonker':
        if (other) {
          this.violenceWarning();
          this.send({ type: 'autoAttack', faction: this.me, target: other.id });
        }
        return;
    }
  }

  private levelUp(): void {
    const b = this.world.buildings.find((x) => x.id === this.selBuilding);
    if (!b || b.faction !== this.me || b.level >= MAX_LEVEL) return;
    const me = this.world.factions[this.me];
    const cost = upgradeCost(me, b);
    if (me.gold < cost) {
      this.hud.say(`${BUILDINGS[b.kind].icon} Level ${b.level + 1} needs ${cost} gold (you have ${Math.floor(me.gold)}). Gold builds up over time.`, 'info');
      sound.play('error');
      return;
    }
    this.send({ type: 'upgrade', faction: this.me, building: b.id });
  }

  private levelUpAll(): void {
    const kind = this.selKind;
    if (!kind) return;
    const d = BUILDINGS[kind];
    const plan = this.world.levelAllPlan(this.me, kind);
    if (!plan.todo.length) {
      this.hud.say(`${d.icon} They're all at the top level.`, 'info');
      return;
    }
    const gold = Math.floor(this.world.factions[this.me].gold);
    if (plan.can === 0) {
      const first = upgradeCost(this.world.factions[this.me], plan.todo[0]);
      this.hud.say(`${d.icon} The cheapest level up needs ${first} gold (you have ${gold}). Gold builds up over time.`, 'info');
      sound.play('error');
      return;
    }
    this.send({ type: 'upgradeAll', faction: this.me, kind });
    if (plan.can < plan.todo.length) {
      this.hud.say(`⬆️ Levelling up ${plan.can} of ${plan.todo.length}, the lowest first. The rest need ${plan.total - plan.canCost} more gold.`, 'info');
    }
  }

  private violenceWarning(): void {
    if (this.warnedViolence) return;
    this.warnedViolence = true;
    this.hud.say('⚠️ Violence works fast, but police arrest attackers and others will trust you less.', 'bad');
  }

  /** Group befriend: aim everyone selected at the crowd around a point (or a tapped stranger). */
  private befriendAt(x: number, y: number, target: Blob | null): void {
    const own = this.ownSelected();
    if (!own.length) return;
    const cx = target?.x ?? x;
    const cy = target?.y ?? y;
    this.send({ type: 'befriendArea', faction: this.me, ids: own.map((b) => b.id), x: cx, y: cy, r: AREA_R, target: target?.id });
    this.r.pulse(cx, cy, AREA_R, 0xff7eb6);
    sound.play('go');
  }

  private usurpAt(bld: Building): void {
    const own = this.ownSelected();
    if (!own.length) return;
    this.send({ type: 'order', faction: this.me, ids: own.map((b) => b.id), order: 'usurp', building: bld.id });
    this.r.pulse(bld.x, bld.y, 80, 0xffffff);
    sound.play('go');
    this.hud.toast(`🏳️ ${own.length > 1 ? `${own.length} blobs go` : `${own[0].name} goes`} to take over the ${BUILDINGS[bld.kind].label}`, 'info');
  }

  private setJob(job: Job): void {
    const own = this.ownSelected();
    if (!own.length) return;
    this.send({ type: 'job', faction: this.me, ids: own.map((b) => b.id), job });
    if (job === 'student' && !this.world.factions[this.me].counts.school) this.hud.say('🏫 Build a School first: students need somewhere to study.', 'bad');
    else if (job !== 'social') this.hud.toast(`${JOBS[job].icon} ${own.length > 1 ? `${own.length} new ${JOBS[job].label.toLowerCase()}s` : `${own[0].name} is now a ${JOBS[job].label}`}. ${JOBS[job].desc}`, 'good');
  }

  private setTeam(tab: TeamTab | null): void {
    this.team = tab;
    if (tab) this.tut?.did.add('team');
    this.buildMode = null;
    this.command = null;
  }

  /** Pick your free grown-up blobs around this one (and it). */
  private selectNear(b: Blob, add = false): void {
    const near = this.world.blobs.filter(
      (x) => x === b || (this.world.commandable(x, this.me) && x.age >= ADULT_AGE && (x.x - b.x) ** 2 + (x.y - b.y) ** 2 < NEAR * NEAR),
    );
    this.selected = new Set([...(add ? this.selected : []), ...near.map((x) => x.id)]);
    this.selBuilding = null;
    this.team = null;
    this.hud.say(
      `👥 Selected ${this.selected.size} blobs. ${this.mode.boxSelect ? 'Now right-click a crowd of strangers.' : 'Now tap a stranger to befriend their crowd.'}`,
      'info',
    );
  }

  private teamPick(id: number): void {
    const b = this.world.byId.get(id);
    if (!b) return;
    this.team = null;
    this.selBuilding = null;
    this.selected = new Set([id]);
    this.jumpTo(b.x, b.y);
  }

  private teamAct(act: TeamAct, ids: number[]): void {
    const w = this.world;
    const blobs = ids.map((id) => w.byId.get(id)).filter((b): b is Blob => !!b && w.commandable(b, this.me));
    if (!blobs.length) return;
    if (act === 'select') {
      this.team = null;
      this.selBuilding = null;
      this.selected = new Set(blobs.map((b) => b.id));
      this.hud.toast(`👥 Picked your top ${blobs.length}. Give them a job, or ${this.mode.boxSelect ? 'right-click a crowd of strangers' : 'tap a stranger to befriend their crowd'}.`, 'info');
      return;
    }
    if (act === 'teacher' || act === 'recruiter') {
      this.send({ type: 'job', faction: this.me, ids: blobs.map((b) => b.id), job: act });
      this.hud.toast(`${JOBS[act].icon} ${blobs.map((b) => b.name).join(', ')} ${blobs.length > 1 ? 'are' : 'is'} now ${JOBS[act].label.toLowerCase()}s`, 'good');
      return;
    }
    // teachThem: the best free teacher for each hot head goes to calm them down.
    const used = new Set<number>(blobs.map((b) => b.id));
    let sent = 0;
    for (const student of blobs) {
      let best: Blob | null = null;
      let bs = 0.1;
      for (const t of w.blobs) {
        if (used.has(t.id) || !w.commandable(t, this.me) || t.age < ADULT_AGE || t.order.kind !== 'none') continue;
        const s = lessonValue(t.traits, student.traits) * (0.5 + t.traits.teaching) - Math.sqrt((t.x - student.x) ** 2 + (t.y - student.y) ** 2) / 1500;
        if (s > bs) {
          bs = s;
          best = t;
        }
      }
      if (!best) continue;
      used.add(best.id);
      this.send({ type: 'order', faction: this.me, ids: [best.id], order: 'teach', target: student.id });
      sent++;
    }
    this.hud.toast(sent ? `📚 Sent ${sent} teacher${sent > 1 ? 's' : ''} to calm the hot heads` : 'No free blob could teach them anything', sent ? 'good' : 'info');
  }

  private order(order: OrderCommand, target?: Blob, x?: number, y?: number): void {
    const own = this.ownSelected();
    if (!own.length) return;
    this.send({ type: 'order', faction: this.me, ids: own.map((b) => b.id), order, target: target?.id, x, y });
    sound.play('go');
    if (order === 'teach' && target) this.hud.toast(`📚 ${own.length > 1 ? `${own.length} blobs go` : `${own[0].name} goes`} to teach ${target.name}`, 'info');
    if (order === 'attack' && target) this.violenceWarning();
  }

  private setFocus(trait: TraitKey): void {
    if (this.selBuilding !== null) this.send({ type: 'focus', faction: this.me, building: this.selBuilding, trait });
  }

  private setSpeed(s: number): void {
    if (this.net) {
      if (this.net.opts.isHost()) this.net.opts.send({ t: 'pace', speed: s, paused: false });
      else this.hud.say('Only the host can change the speed.', 'info');
      return;
    }
    this.speed = s;
    this.paused = false;
  }

  private togglePause(): void {
    if (this.net) {
      if (this.net.opts.isHost()) this.net.opts.send({ t: 'pace', paused: !this.paused });
      else this.hud.say('Only the host can pause.', 'info');
      return;
    }
    this.paused = !this.paused;
  }

  /** Centre the camera on a point, in the part of the screen the HUD leaves clear. */
  private jumpTo(x: number, y: number): void {
    const cam = this.r.camera;
    const a = this.hud.freeArea();
    cam.x = x - ((a.x0 + a.x1) / 2 - cam.sw / 2) / cam.zoom;
    cam.y = y - ((a.y0 + a.y1) / 2 - cam.sh / 2) / cam.zoom;
  }

  // ───────────────────────────── input ─────────────────────────────

  private bindInput(): void {
    const canvas = this.r.app.canvas;
    const on = <K extends keyof HTMLElementEventMap>(el: HTMLElement | Window, ev: K, fn: (e: HTMLElementEventMap[K]) => void, opts?: AddEventListenerOptions): void => {
      el.addEventListener(ev, fn as EventListener, opts);
      this.cleanup.push(() => el.removeEventListener(ev, fn as EventListener, opts));
    };
    on(canvas, 'pointerdown', (e) => this.onDown(e));
    on(canvas, 'pointermove', (e) => this.onMove(e));
    on(canvas, 'pointerup', (e) => this.onUp(e));
    on(canvas, 'pointercancel', (e) => this.onUp(e, true));
    on(canvas, 'pointerleave', () => (this.hover = this.mode.id === 'casual' ? this.hover : null));
    on(canvas, 'contextmenu', (e) => e.preventDefault());
    on(canvas, 'wheel', (e) => this.onWheel(e), { passive: false });
    on(window, 'keydown', (e) => this.onKey(e));
    on(window, 'keyup', (e) => this.keys.delete(e.key));
    on(window, 'blur', () => this.keys.clear());
  }

  private local(e: PointerEvent | WheelEvent): { x: number; y: number } {
    const rect = this.r.app.canvas.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  private onDown(e: PointerEvent): void {
    if (this.adHold) return;
    const p = this.local(e);
    this.pointers.set(e.pointerId, { x: p.x, y: p.y, sx: p.x, sy: p.y, button: e.button, mouse: e.pointerType === 'mouse' });
    try {
      this.r.app.canvas.setPointerCapture(e.pointerId);
    } catch {
      // Synthetic or already-released pointers can't be captured; input still works without it.
    }
    if (this.pointers.size === 2) {
      this.drag = 'pinch';
      this.suppressTap = true;
      this.r.setBox(null);
      this.pinch = this.pinchInfo();
    }
  }

  private pinchInfo(): { d: number; mx: number; my: number } {
    const [a, b] = [...this.pointers.values()];
    return { d: Math.hypot(a.x - b.x, a.y - b.y), mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2 };
  }

  private onMove(e: PointerEvent): void {
    const p = this.local(e);
    if (e.pointerType === 'mouse') this.hover = this.r.camera.toWorld(p.x, p.y);
    const info = this.pointers.get(e.pointerId);
    if (!info) return;
    const dx = p.x - info.x;
    const dy = p.y - info.y;
    info.x = p.x;
    info.y = p.y;

    if (this.drag === 'pinch') {
      if (this.pointers.size < 2) return;
      const now = this.pinchInfo();
      if (this.pinch.d > 0) this.r.camera.zoomAt(now.mx, now.my, now.d / this.pinch.d);
      this.r.camera.pan(now.mx - this.pinch.mx, now.my - this.pinch.my);
      this.pinch = now;
      return;
    }
    if (this.drag === 'none' && Math.hypot(p.x - info.sx, p.y - info.sy) > 8) {
      if (info.mouse && info.button === 0 && this.mode.boxSelect && !this.buildingsOnly) this.drag = 'box';
      else this.drag = 'pan';
    }
    if (this.drag === 'pan') this.r.camera.pan(dx, dy);
    else if (this.drag === 'box') this.r.setBox({ x0: info.sx, y0: info.sy, x1: p.x, y1: p.y });
  }

  private onUp(e: PointerEvent, cancelled = false): void {
    const info = this.pointers.get(e.pointerId);
    this.pointers.delete(e.pointerId);
    if (!info) return;
    if (this.drag === 'box') {
      this.finishBox(info, e.shiftKey);
      this.r.setBox(null);
    } else if (this.drag === 'none' && !this.suppressTap && !cancelled) {
      const wpt = this.r.camera.toWorld(info.x, info.y);
      if (!info.mouse) this.hover = wpt;
      this.click(wpt.x, wpt.y, info.button, e.shiftKey);
    }
    if (this.pointers.size === 0) {
      this.drag = 'none';
      this.suppressTap = false;
    } else if (this.drag === 'pinch') {
      this.drag = 'pan';
    }
  }

  private onWheel(e: WheelEvent): void {
    e.preventDefault();
    const p = this.local(e);
    const k = e.ctrlKey ? 0.01 : 0.0015;
    this.r.camera.zoomAt(p.x, p.y, Math.exp(-e.deltaY * k));
  }

  private finishBox(info: PointerInfo, add: boolean): void {
    const a = this.r.camera.toWorld(info.sx, info.sy);
    const b = this.r.camera.toWorld(info.x, info.y);
    const x0 = Math.min(a.x, b.x);
    const x1 = Math.max(a.x, b.x);
    const y0 = Math.min(a.y, b.y);
    const y1 = Math.max(a.y, b.y);
    if (!add) this.selected.clear();
    this.selBuilding = null;
    for (const bl of this.world.blobs) {
      if (bl.faction === this.me && bl.role !== 'police' && bl.x >= x0 && bl.x <= x1 && bl.y >= y0 && bl.y <= y1) this.selected.add(bl.id);
    }
    if (this.selected.size) this.tut?.did.add('box');
    this.command = null;
  }

  private pickBlob(x: number, y: number): Blob | null {
    if (this.buildingsOnly) return null;
    const r = Math.max(16, 26 / this.r.camera.zoom);
    let best: Blob | null = null;
    let bd = r * r;
    for (const b of this.world.blobs) {
      const d = (b.x - x) ** 2 + (b.y - 6 - y) ** 2;
      if (d < bd) {
        bd = d;
        best = b;
      }
    }
    return best;
  }

  /** The befriendable blob nearest a tap that just missed one. */
  private strangerNear(x: number, y: number): Blob | null {
    const r = Math.min(120, MISS_PX / this.r.camera.zoom);
    let best: Blob | null = null;
    let bd = r * r;
    for (const b of this.world.blobs) {
      if (!b.alive || b.faction === this.me || b.role === 'police' || b.jail > 0) continue;
      const d = (b.x - x) ** 2 + (b.y - 6 - y) ** 2;
      if (d < bd) {
        bd = d;
        best = b;
      }
    }
    return best;
  }

  private pickBuilding(x: number, y: number): Building | undefined {
    // When buildings are all you can click, the tap target can afford to be generous.
    return this.buildingsOnly ? this.r.buildingAt(x, y, Math.max(14, 26 / this.r.camera.zoom)) : this.r.buildingAt(x, y);
  }

  private click(x: number, y: number, button: number, shift: boolean): void {
    const w = this.world;
    if (w.outcome) {
      // Game over: you can still look around and inspect, but not give orders.
      this.buildMode = null;
      this.command = null;
      if (button !== 0) return;
      const blob = this.pickBlob(x, y);
      this.selected = blob ? new Set([blob.id]) : new Set();
      const bld = blob ? undefined : this.pickBuilding(x, y);
      this.selBuilding = bld ? bld.id : null;
      return;
    }
    if (this.buildMode) {
      if (button === 2) {
        this.buildMode = null;
        return;
      }
      const res = w.canPlace(this.me, this.buildMode, x, y);
      if (!res.ok) {
        this.hud.say(res.reason, 'info');
        sound.play('error');
        return;
      }
      this.send({ type: 'build', faction: this.me, kind: this.buildMode, x, y });
      if (!shift) this.buildMode = null;
      return;
    }

    const blob = this.pickBlob(x, y);
    const own = this.ownSelected();

    const bld = blob ? undefined : this.pickBuilding(x, y);
    const rivalBld = bld && bld.faction !== this.me && bld.faction !== 0 ? bld : undefined;

    if (button === 2) {
      if (!own.length) return;
      this.tut?.did.add('rightClick');
      if (blob && blob.faction !== this.me) {
        if (this.command === 'attack') this.order('attack', blob);
        else this.befriendAt(x, y, blob);
      } else if (blob && !own.includes(blob)) this.order('teach', blob);
      else if (rivalBld) this.usurpAt(rivalBld);
      else this.order('move', undefined, x, y);
      this.command = null;
      return;
    }

    if (this.command && own.length) {
      if (this.command === 'move') this.order('move', undefined, x, y);
      else if (this.command === 'befriend') this.befriendAt(x, y, blob && blob.faction !== this.me ? blob : null);
      else if (this.command === 'usurp') {
        if (!rivalBld) {
          this.hud.say('Pick a building from another team', 'info');
          return;
        }
        this.usurpAt(rivalBld);
      } else if (this.command === 'teach') {
        if (!blob || blob.faction !== this.me || own.includes(blob)) {
          this.hud.say('Pick a different blob from your own team', 'info');
          return;
        }
        this.order('teach', blob);
      } else if (blob && blob.faction !== this.me) this.order(this.command, blob);
      else {
        this.hud.say('Pick a blob from another team', 'info');
        return;
      }
      this.command = null;
      return;
    }

    // Casual shortcuts: with your blobs selected, tapping a stranger befriends their crowd,
    // tapping a rival building takes it over.
    if (!this.mode.boxSelect && own.length && blob && blob.faction !== this.me) {
      this.befriendAt(x, y, blob);
      return;
    }
    if ((!this.mode.boxSelect || this.buildingView) && own.length && rivalBld) {
      this.usurpAt(rivalBld);
      return;
    }

    if (blob) {
      this.selBuilding = null;
      this.team = null;
      sound.play('select');
      // Double tap one of yours: pick the blobs around it too.
      const now = performance.now();
      const last = this.lastBlobTap;
      const again =
        blob.faction === this.me &&
        now - last.at < 400 &&
        (last.id === blob.id || Math.hypot(x - last.x, y - last.y) < 24 / this.r.camera.zoom);
      this.lastBlobTap = { id: blob.faction === this.me ? blob.id : -1, x, y, at: now };
      if (again) {
        this.lastBlobTap.at = 0;
        this.selectNear(blob, shift);
        return;
      }
      if (shift && blob.faction === this.me) {
        if (this.selected.has(blob.id)) this.selected.delete(blob.id);
        else this.selected.add(blob.id);
      } else {
        this.selected = new Set([blob.id]);
      }
      return;
    }
    // In the buildings view, missing a building shouldn't lose the blobs you picked.
    if (this.buildingView && !bld && own.length) return;
    // Casual, with your blobs picked: a tap just beside a wandering stranger still reaches
    // their crowd, and a tap on open grass walks your blobs there. ✕ on the panel lets go.
    if (!this.mode.boxSelect && own.length && !bld) {
      const near = this.strangerNear(x, y);
      if (near) {
        this.befriendAt(x, y, near);
      } else {
        this.order('move', undefined, x, y);
        this.r.pulse(x, y, 28, 0xffffff);
        if (this.once('tipMove', Infinity)) this.hud.toast('🚶 Walking there. ✕ on the panel lets them go.', 'info');
      }
      return;
    }
    // Double tap one of yours: pick every building of that kind.
    const now = performance.now();
    const again = bld && bld.faction === this.me && this.lastBuildingTap.id === bld.id && now - this.lastBuildingTap.at < 400;
    this.lastBuildingTap = { id: bld && bld.faction === this.me ? bld.id : -1, at: now };
    if (bld && again) {
      this.selectKind(bld);
      return;
    }
    this.selected.clear();
    this.selBuilding = bld ? bld.id : null;
    if (bld) this.team = null;
  }

  private onKey(e: KeyboardEvent): void {
    if ((e.target as HTMLElement)?.tagName === 'INPUT' || this.adHold) return;
    const k = e.key.toLowerCase();
    this.keys.add(e.key);
    const mod = e.ctrlKey || e.metaKey;
    if (k === ' ') {
      e.preventDefault();
      this.togglePause();
      return;
    }
    if (k === 'm') {
      sound.toggle();
      return;
    }
    if (k === 'escape') {
      if (this.team) {
        this.team = null;
      } else if (this.buildMode || this.command) {
        this.buildMode = null;
        this.command = null;
      } else if (this.buildingView) {
        this.buildingView = false;
      } else {
        this.selected.clear();
        this.selBuilding = null;
      }
      return;
    }
    if (!this.mode.hotkeys) return;
    if (mod && k === 'a') {
      e.preventDefault();
      this.selected = new Set(this.world.blobs.filter((b) => this.world.commandable(b, this.me)).map((b) => b.id));
      this.selBuilding = null;
      return;
    }
    if (/^[1-9]$/.test(k)) {
      if (mod) {
        e.preventDefault();
        const ids = this.ownSelected().map((b) => b.id);
        this.groups.set(k, ids);
        this.hud.toast(`Group ${k} saved`, 'info');
        if (ids.length) this.tut?.did.add('groupSave');
      } else {
        const g = this.groups.get(k)?.filter((id) => this.world.byId.has(id)) ?? [];
        this.selected = new Set(g);
        this.selBuilding = null;
        if (g.length) this.tut?.did.add('groupRecall');
      }
      return;
    }
    if (mod) return;
    if (BUILD_HOTKEYS[k] && BUILD_MENU.includes(BUILD_HOTKEYS[k])) return this.toggleBuild(BUILD_HOTKEYS[k]);
    if (k === 'f') return this.panelAction('befriend');
    if (k === 'x') return this.panelAction('attack');
    if (k === 'c') return this.panelAction('teach');
    if (k === 'u') return this.panelAction('usurp');
    if (k === 'b') return this.toggleBuildingView();
    if (k === 'v') return this.panelAction('upgrade');
    if (k === 'tab') {
      e.preventDefault();
      return this.setTeam(this.team ? null : 'charm');
    }
    if (k === 'g') return this.panelAction('move');
    if (k === 's') return this.panelAction('stop');
    if (k === 'h') {
      const hall = this.world.hall(this.me);
      if (hall) this.jumpTo(hall.x, hall.y);
      return;
    }
    if (k === '=' || k === '+' || k === '-') {
      const sp = this.mode.speeds;
      const i = sp.indexOf(this.speed);
      this.setSpeed(sp[Math.max(0, Math.min(sp.length - 1, i + (k === '-' ? -1 : 1)))]);
    }
  }

  private keyboardPan(dt: number): void {
    let dx = 0;
    let dy = 0;
    if (this.keys.has('ArrowLeft')) dx += 1;
    if (this.keys.has('ArrowRight')) dx -= 1;
    if (this.keys.has('ArrowUp')) dy += 1;
    if (this.keys.has('ArrowDown')) dy -= 1;
    if (dx || dy) this.r.camera.pan(dx * 700 * dt, dy * 700 * dt);
  }
}
