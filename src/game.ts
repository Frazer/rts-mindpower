import type { ModeConfig } from './modes';
import { GameRenderer } from './render/renderer';
import { ADULT_AGE, BUILD_MENU, BUILDINGS, DT, PLAYER, buildCost } from './sim/config';
import type { TraitKey } from './sim/traits';
import { lessonValue } from './sim/systems/jobs';
import type { Blob, Building, BuildingKind, Job, OrderCommand, SimEvent } from './sim/types';
import { World } from './sim/world';
import { Hud, JOBS, type CommandMode, type PanelAction, type TeamAct, type TeamTab } from './ui/hud';

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

export interface GameCallbacks {
  onMenu(): void;
  onRestart(): void;
}

/** Owns the loop and turns input into sim commands. */
export class Game {
  private selected = new Set<number>();
  private selBuilding: number | null = null;
  private buildMode: BuildingKind | null = null;
  private command: CommandMode = null;
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
  private readonly cleanup: (() => void)[] = [];

  private constructor(
    private readonly mode: ModeConfig,
    private readonly world: World,
    private readonly r: GameRenderer,
    private readonly hud: Hud,
  ) {
    this.speed = mode.defaultSpeed;
  }

  static async start(mode: ModeConfig, host: HTMLElement, hudRoot: HTMLElement, cb: GameCallbacks, seed = Date.now()): Promise<Game> {
    const world = new World(mode, seed);
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
    });
    game = new Game(mode, world, r, hud);
    game.init();
    return game;
  }

  private init(): void {
    const hall = this.world.hall(PLAYER)!;
    const cam = this.r.camera;
    cam.x = hall.x;
    cam.y = hall.y;
    cam.zoom = this.mode.id === 'casual' ? 1.05 : 0.9;
    this.bindInput();
    this.r.app.ticker.add(this.frame);
    this.hud.toast(
      this.mode.id === 'casual'
        ? '👋 Tap one of your blue blobs, then tap a stranger to befriend them! 👥 Team finds your best blobs.'
        : '👋 Box-select blobs, right-click a crowd to befriend it. Right-click a rival building to take it over. Tab = team.',
      'info',
    );
  }

  destroy(): void {
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

    if (!this.paused && !w.outcome) {
      this.acc += dt * this.speed;
      let steps = 0;
      while (this.acc >= DT && steps < 10) {
        w.tick(DT);
        this.acc -= DT;
        steps++;
      }
      if (steps === 10) this.acc = 0;
    }

    this.keyboardPan(dt);
    const events = w.drainEvents();
    this.r.fx(events);
    this.narrate(events);

    for (const id of this.selected) if (!w.byId.has(id)) this.selected.delete(id);

    if (this.buildMode && this.hover) {
      const ok = w.canPlace(PLAYER, this.buildMode, this.hover.x, this.hover.y).ok;
      this.r.setGhost(this.buildMode, this.hover.x, this.hover.y, ok, w.factions[PLAYER].color);
    } else {
      this.r.setGhost(null);
    }

    this.r.render(this.paused ? 1 : this.acc / DT, now, dt, this.selected, this.selBuilding, this.buildMode ? PLAYER : -1);

    this.hudTimer -= dt;
    if (this.hudTimer <= 0) {
      this.hudTimer = 0.2;
      this.hud.update(w, this.hudState());
      const [hint, sub] = this.hintText();
      this.hud.hint(hint, sub);
    }
    this.miniTimer -= dt;
    if (this.miniTimer <= 0) {
      this.miniTimer = 0.25;
      this.hud.drawMinimap(w, this.r.camera.view());
    }
    if (w.outcome) this.hud.showEnd(w);
  };

  private hudState() {
    const blobs = [...this.selected].map((id) => this.world.byId.get(id)).filter((b): b is Blob => !!b);
    const building = this.selBuilding !== null ? (this.world.buildings.find((b) => b.id === this.selBuilding) ?? null) : null;
    return { selected: blobs, building, buildMode: this.buildMode, command: this.command, speed: this.speed, paused: this.paused, team: this.team };
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
    const name = (f: number): string => (f === PLAYER ? 'you' : (w.factions[f]?.name ?? '?'));
    const color = (f: number): number => w.factions[f]?.color ?? 0x999999;
    for (const e of events) {
      switch (e.type) {
        case 'convert':
          if (e.faction === PLAYER) {
            this.hud.toast(`💗 ${e.text} joined you!`, 'good');
            if (this.once('tipTeach', Infinity)) {
              this.hud.toast('📚 Tip: select a charming blob and press Teach to pass its best traits to a teammate.', 'info');
            }
          }
          else if (e.other === PLAYER) this.hud.toast(`💔 ${e.text} was won over by ${name(e.faction)}`, 'bad');
          this.hud.log(`${e.text}: ${w.factions[e.other].name} → ${w.factions[e.faction].name}`, color(e.faction));
          break;
        case 'fearConvert':
          if (e.faction === PLAYER) this.hud.toast(`😨 ${e.text} gave in out of fear (shaky loyalty)`, 'info');
          else if (e.other === PLAYER) this.hud.toast(`😨 ${e.text} was scared into joining ${name(e.faction)}`, 'bad');
          this.hud.log(`${e.text} scared into ${w.factions[e.faction].name}`, color(e.faction));
          break;
        case 'defect':
          if (e.other === PLAYER) this.hud.toast(`💨 ${e.text} left to wander`, 'bad');
          break;
        case 'hit':
          if (e.other === PLAYER && this.once('hurt', 6)) this.hud.toast(`💥 ${e.text} is attacking your blobs!`, 'bad');
          if (e.faction === PLAYER && this.once('violent', 8)) this.hud.toast(`💥 ${e.text} turned violent — now wanted 🚨`, 'bad');
          if (this.once(`hitlog${e.blob}`, 5)) this.hud.log(`${e.text} attacked a ${w.factions[e.other].name} blob`, color(e.faction));
          break;
        case 'kill':
          if (e.other === PLAYER) this.hud.toast(`👻 ${e.text} was knocked out for good`, 'bad');
          this.hud.log(`${e.text} (${w.factions[e.other].name}) was killed`, color(e.faction));
          break;
        case 'arrest':
          if (e.other === PLAYER) this.hud.toast(`🚨 ${e.text} was arrested`, 'bad');
          else if (e.faction === PLAYER) this.hud.toast(`🚓 Your police arrested ${e.text}`, 'good');
          this.hud.log(`${e.text} arrested by ${w.factions[e.faction].name} police`, color(e.faction));
          break;
        case 'tech':
          if (e.faction === PLAYER) this.hud.toast(`💡 ${e.text}! Smarter police & better persuasion`, 'good');
          this.hud.log(`${w.factions[e.faction].name} reached ${e.text}`, color(e.faction));
          break;
        case 'recruit':
          if (e.faction === PLAYER) this.hud.toast(`⭐ ${e.text} joined your police`, 'info');
          break;
        case 'build':
          if (e.faction !== PLAYER && e.faction >= 0) this.hud.log(`${w.factions[e.faction].name} built a ${e.text}`, color(e.faction));
          if (e.faction === PLAYER && w.buildings.find((b) => b.id === e.target)?.kind === 'school') {
            this.selected.clear();
            this.selBuilding = e.target;
            this.hud.toast('🏫 Pick what your school teaches. Your blobs inside the circle learn it.', 'info');
          }
          break;
        case 'taught':
          if (e.faction === PLAYER && e.manual) this.hud.toast(`📚 ${e.text}`, 'good');
          else if (e.faction === PLAYER && this.once('jobLesson', 20)) this.hud.log(`📚 ${e.text}`, color(e.faction));
          break;
        case 'usurping':
          if (e.other === PLAYER && this.once(`usurping${e.target}`, 15)) {
            this.hud.toast(`🏳️ ${w.factions[e.faction].name} are taking over your ${e.text}! Send blobs to stand there.`, 'bad');
          }
          this.hud.log(`${w.factions[e.faction].name} started taking over a ${w.factions[e.other].name} ${e.text}`, color(e.faction));
          break;
        case 'usurp':
          if (e.faction === PLAYER) this.hud.toast(`🏳️ You took over the ${e.text}!`, 'good');
          else if (e.other === PLAYER) this.hud.toast(`😱 ${w.factions[e.faction].name} took your ${e.text}`, 'bad');
          this.hud.log(`${w.factions[e.faction].name} took a ${w.factions[e.other].name} ${e.text}`, color(e.faction));
          break;
        case 'notice':
          if (e.faction === PLAYER) this.hud.toast(e.text, 'info');
          break;
        default:
          break;
      }
    }
  }

  // ───────────────────────────── actions ─────────────────────────────

  private ownSelected(): Blob[] {
    return [...this.selected]
      .map((id) => this.world.byId.get(id))
      .filter((b): b is Blob => !!b && this.world.commandable(b, PLAYER));
  }

  private toggleBuild(kind: BuildingKind): void {
    this.command = null;
    const me = this.world.factions[PLAYER];
    const cost = buildCost(me, kind);
    if (this.buildMode !== kind && me.gold < cost) {
      const d = BUILDINGS[kind];
      this.hud.toast(`${d.icon} ${d.label} needs ${cost} gold (you have ${Math.floor(me.gold)}). Gold builds up over time.`, 'info');
      return;
    }
    this.buildMode = this.buildMode === kind ? null : kind;
    if (this.buildMode && this.mode.id === 'casual') {
      const hall = this.world.hall(PLAYER);
      if (hall) this.hover = { x: hall.x, y: hall.y };
    }
  }

  private panelAction(a: PanelAction): void {
    const own = this.ownSelected();
    const other = [...this.selected].map((id) => this.world.byId.get(id)).find((b) => b && b.faction !== PLAYER);
    switch (a) {
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
      case 'sendFriend':
        if (other) this.world.command({ type: 'autoBefriend', faction: PLAYER, target: other.id, count: 3 });
        return;
      case 'sendUsurp':
        if (this.selBuilding !== null) this.world.command({ type: 'autoUsurp', faction: PLAYER, building: this.selBuilding, count: 5 });
        return;
      case 'nearby': {
        const b = own[0];
        if (!b) return;
        const near = this.world.blobs.filter(
          (x) => this.world.commandable(x, PLAYER) && x.age >= ADULT_AGE && (x.x - b.x) ** 2 + (x.y - b.y) ** 2 < 260 * 260,
        );
        this.selected = new Set(near.map((x) => x.id));
        this.hud.toast(`👥 Selected ${near.length} blobs. Now tap 💗 Befriend and tap a crowd.`, 'info');
        return;
      }
      case 'sendBonker':
        if (other) {
          this.violenceWarning();
          this.world.command({ type: 'autoAttack', faction: PLAYER, target: other.id });
        }
        return;
    }
  }

  private violenceWarning(): void {
    if (this.warnedViolence) return;
    this.warnedViolence = true;
    this.hud.toast('⚠️ Violence works fast, but police arrest attackers and others will trust you less.', 'bad');
  }

  /** Group befriend: aim everyone selected at the crowd around a point (or a tapped stranger). */
  private befriendAt(x: number, y: number, target: Blob | null): void {
    const own = this.ownSelected();
    if (!own.length) return;
    const cx = target?.x ?? x;
    const cy = target?.y ?? y;
    this.world.command({ type: 'befriendArea', faction: PLAYER, ids: own.map((b) => b.id), x: cx, y: cy, r: AREA_R, target: target?.id });
    this.r.pulse(cx, cy, AREA_R, 0xff7eb6);
  }

  private usurpAt(bld: Building): void {
    const own = this.ownSelected();
    if (!own.length) return;
    this.world.command({ type: 'order', faction: PLAYER, ids: own.map((b) => b.id), order: 'usurp', building: bld.id });
    this.r.pulse(bld.x, bld.y, 80, 0xffffff);
    this.hud.toast(`🏳️ ${own.length > 1 ? `${own.length} blobs go` : `${own[0].name} goes`} to take over the ${BUILDINGS[bld.kind].label}`, 'info');
  }

  private setJob(job: Job): void {
    const own = this.ownSelected();
    if (!own.length) return;
    this.world.command({ type: 'job', faction: PLAYER, ids: own.map((b) => b.id), job });
    if (job !== 'social') this.hud.toast(`${JOBS[job].icon} ${own.length > 1 ? `${own.length} new ${JOBS[job].label.toLowerCase()}s` : `${own[0].name} is now a ${JOBS[job].label}`}. ${JOBS[job].desc}`, 'good');
  }

  private setTeam(tab: TeamTab | null): void {
    this.team = tab;
    this.buildMode = null;
    this.command = null;
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
    const blobs = ids.map((id) => w.byId.get(id)).filter((b): b is Blob => !!b && w.commandable(b, PLAYER));
    if (!blobs.length) return;
    if (act === 'select') {
      this.team = null;
      this.selBuilding = null;
      this.selected = new Set(blobs.map((b) => b.id));
      this.hud.toast(`👥 Selected ${blobs.length}. Tap 💗 Befriend, then tap a crowd of strangers.`, 'info');
      return;
    }
    if (act === 'teacher' || act === 'recruiter') {
      w.command({ type: 'job', faction: PLAYER, ids: blobs.map((b) => b.id), job: act });
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
        if (used.has(t.id) || !w.commandable(t, PLAYER) || t.age < ADULT_AGE || t.order.kind !== 'none') continue;
        const s = lessonValue(t.traits, student.traits) * (0.5 + t.traits.teaching) - Math.sqrt((t.x - student.x) ** 2 + (t.y - student.y) ** 2) / 1500;
        if (s > bs) {
          bs = s;
          best = t;
        }
      }
      if (!best) continue;
      used.add(best.id);
      w.command({ type: 'order', faction: PLAYER, ids: [best.id], order: 'teach', target: student.id });
      sent++;
    }
    this.hud.toast(sent ? `📚 Sent ${sent} teacher${sent > 1 ? 's' : ''} to calm the hot heads` : 'No free blob could teach them anything', sent ? 'good' : 'info');
  }

  private order(order: OrderCommand, target?: Blob, x?: number, y?: number): void {
    const own = this.ownSelected();
    if (!own.length) return;
    this.world.command({ type: 'order', faction: PLAYER, ids: own.map((b) => b.id), order, target: target?.id, x, y });
    if (order === 'teach' && target) this.hud.toast(`📚 ${own.length > 1 ? `${own.length} blobs go` : `${own[0].name} goes`} to teach ${target.name}`, 'info');
    if (order === 'attack' && target) this.violenceWarning();
  }

  private setFocus(trait: TraitKey): void {
    if (this.selBuilding !== null) this.world.command({ type: 'focus', faction: PLAYER, building: this.selBuilding, trait });
  }

  private setSpeed(s: number): void {
    this.speed = s;
    this.paused = false;
  }

  private togglePause(): void {
    this.paused = !this.paused;
  }

  private jumpTo(x: number, y: number): void {
    this.r.camera.x = x;
    this.r.camera.y = y;
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
      if (info.mouse && info.button === 0 && this.mode.boxSelect && !this.buildMode) this.drag = 'box';
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
      if (bl.faction === PLAYER && bl.role !== 'police' && bl.x >= x0 && bl.x <= x1 && bl.y >= y0 && bl.y <= y1) this.selected.add(bl.id);
    }
    this.command = null;
  }

  private pickBlob(x: number, y: number): Blob | null {
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

  private click(x: number, y: number, button: number, shift: boolean): void {
    const w = this.world;
    if (w.outcome) {
      // Game over: you can still look around and inspect, but not give orders.
      this.buildMode = null;
      this.command = null;
      if (button !== 0) return;
      const blob = this.pickBlob(x, y);
      this.selected = blob ? new Set([blob.id]) : new Set();
      const bld = blob ? undefined : this.r.buildingAt(x, y);
      this.selBuilding = bld ? bld.id : null;
      return;
    }
    if (this.buildMode) {
      if (button === 2) {
        this.buildMode = null;
        return;
      }
      const res = w.canPlace(PLAYER, this.buildMode, x, y);
      if (!res.ok) {
        this.hud.toast(res.reason, 'info');
        return;
      }
      w.command({ type: 'build', faction: PLAYER, kind: this.buildMode, x, y });
      if (!shift) this.buildMode = null;
      return;
    }

    const blob = this.pickBlob(x, y);
    const own = this.ownSelected();

    const bld = blob ? undefined : this.r.buildingAt(x, y);
    const rivalBld = bld && bld.faction !== PLAYER && bld.faction !== 0 ? bld : undefined;

    if (button === 2) {
      if (!own.length) return;
      if (blob && blob.faction !== PLAYER) {
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
      else if (this.command === 'befriend') this.befriendAt(x, y, blob && blob.faction !== PLAYER ? blob : null);
      else if (this.command === 'usurp') {
        if (!rivalBld) {
          this.hud.toast('Pick a building from another team', 'info');
          return;
        }
        this.usurpAt(rivalBld);
      } else if (this.command === 'teach') {
        if (!blob || blob.faction !== PLAYER || own.includes(blob)) {
          this.hud.toast('Pick a different blob from your own team', 'info');
          return;
        }
        this.order('teach', blob);
      } else if (blob && blob.faction !== PLAYER) this.order(this.command, blob);
      else {
        this.hud.toast('Pick a blob from another team', 'info');
        return;
      }
      this.command = null;
      return;
    }

    // Casual shortcuts: with your blobs selected, tapping a stranger befriends their crowd,
    // tapping a rival building takes it over.
    if (!this.mode.boxSelect && own.length && blob && blob.faction !== PLAYER) {
      this.befriendAt(x, y, blob);
      return;
    }
    if (!this.mode.boxSelect && own.length && rivalBld) {
      this.usurpAt(rivalBld);
      return;
    }

    if (blob) {
      this.selBuilding = null;
      this.team = null;
      if (shift && blob.faction === PLAYER) {
        if (this.selected.has(blob.id)) this.selected.delete(blob.id);
        else this.selected.add(blob.id);
      } else {
        this.selected = new Set([blob.id]);
      }
      return;
    }
    this.selected.clear();
    this.selBuilding = bld ? bld.id : null;
    if (bld) this.team = null;
  }

  private onKey(e: KeyboardEvent): void {
    if ((e.target as HTMLElement)?.tagName === 'INPUT') return;
    const k = e.key.toLowerCase();
    this.keys.add(e.key);
    const mod = e.ctrlKey || e.metaKey;
    if (k === ' ') {
      e.preventDefault();
      this.togglePause();
      return;
    }
    if (k === 'escape') {
      if (this.team) {
        this.team = null;
      } else if (this.buildMode || this.command) {
        this.buildMode = null;
        this.command = null;
      } else {
        this.selected.clear();
        this.selBuilding = null;
      }
      return;
    }
    if (!this.mode.hotkeys) return;
    if (mod && k === 'a') {
      e.preventDefault();
      this.selected = new Set(this.world.blobs.filter((b) => this.world.commandable(b, PLAYER)).map((b) => b.id));
      this.selBuilding = null;
      return;
    }
    if (/^[1-9]$/.test(k)) {
      if (mod) {
        e.preventDefault();
        this.groups.set(k, this.ownSelected().map((b) => b.id));
        this.hud.toast(`Group ${k} saved`, 'info');
      } else {
        const g = this.groups.get(k)?.filter((id) => this.world.byId.has(id)) ?? [];
        this.selected = new Set(g);
        this.selBuilding = null;
      }
      return;
    }
    if (mod) return;
    if (BUILD_HOTKEYS[k] && BUILD_MENU.includes(BUILD_HOTKEYS[k])) return this.toggleBuild(BUILD_HOTKEYS[k]);
    if (k === 'f') return this.panelAction('befriend');
    if (k === 'x') return this.panelAction('attack');
    if (k === 'c') return this.panelAction('teach');
    if (k === 'u') return this.panelAction('usurp');
    if (k === 'tab') {
      e.preventDefault();
      return this.setTeam(this.team ? null : 'charm');
    }
    if (k === 'g') return this.panelAction('move');
    if (k === 's') return this.panelAction('stop');
    if (k === 'h') {
      const hall = this.world.hall(PLAYER);
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
