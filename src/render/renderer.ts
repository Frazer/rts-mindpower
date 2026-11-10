import { Application, Container, Graphics, Sprite } from 'pixi.js';
import { BUILDINGS, USURP_RADIUS, fountainRadius, policeDetectRadius, schoolRadius } from '../sim/config';
import type { Building, BuildingKind, SimEvent } from '../sim/types';
import type { Obstacle } from '../sim/maps';
import type { World } from '../sim/world';
import { BlobView } from './blobView';
import { Camera } from './camera';
import { makeTextures, type Textures } from './textures';

interface Particle {
  s: Sprite;
  vx: number;
  vy: number;
  life: number;
  max: number;
  scale: number;
}

interface BuildingView {
  root: Container;
  light?: Graphics;
  faction: number;
  level: number;
  stars: Container;
}

interface Pulse {
  x: number;
  y: number;
  r: number;
  color: number;
  life: number;
}

const OUTLINE = 0x6b4f5a;

/** How visible blobs (and their hearts and speech) stay while the player is looking at buildings. */
const FADED_BLOBS = 0.08;

/** Draws the world: ground, territory, buildings, blobs, effects. Reads sim state, never writes it. */
export class GameRenderer {
  readonly camera: Camera;
  readonly tx: Textures;
  private readonly worldLayer = new Container();
  private readonly ground = new Graphics();
  private readonly territory = new Graphics();
  private readonly ranges = new Graphics();
  /** Per-frame marks: takeover bars, tap pulses. */
  private readonly marks = new Graphics();
  private readonly pulses: Pulse[] = [];
  private readonly buildingLayer = new Container({ sortableChildren: true });
  private readonly blobLayer = new Container({ sortableChildren: true });
  private readonly fxLayer = new Container();
  private readonly overlay = new Graphics();
  private readonly ghost = new Container();
  private ghostKind: BuildingKind | null = null;
  private readonly views = new Map<number, BlobView>();
  private readonly bviews = new Map<number, BuildingView>();
  private readonly particles: Particle[] = [];
  private territoryKey = '';

  private constructor(readonly app: Application, private readonly world: World) {
    this.tx = makeTextures(app.renderer);
    this.camera = new Camera(world.w, world.h);
    this.worldLayer.addChild(this.ground, this.territory, this.ranges, this.buildingLayer, this.blobLayer, this.marks, this.ghost, this.fxLayer);
    app.stage.addChild(this.worldLayer, this.overlay);
    this.drawGround();
    this.ghost.visible = false;
    this.ghost.alpha = 0.65;
  }

  static async create(host: HTMLElement, world: World): Promise<GameRenderer> {
    const app = new Application();
    await app.init({
      resizeTo: host,
      antialias: true,
      background: '#8fc46f',
      autoDensity: true,
      resolution: Math.min(window.devicePixelRatio || 1, 2),
    });
    host.appendChild(app.canvas);
    return new GameRenderer(app, world);
  }

  destroy(): void {
    this.app.destroy(true, { children: true, texture: true });
  }

  private drawGround(): void {
    const { w, h } = this.world;
    const g = this.ground;
    g.roundRect(0, 0, w, h, 40).fill(0xcdeaa8).stroke({ width: 10, color: 0xa6cf86 });
    const n = Math.round((w * h) / 7000);
    for (let i = 0; i < n; i++) {
      const x = 20 + Math.random() * (w - 40);
      const y = 20 + Math.random() * (h - 40);
      const r = Math.random();
      if (r < 0.55) g.ellipse(x, y, 6 + Math.random() * 4, 2.5 + Math.random() * 1.5).fill(0xb8dc96);
      else if (r < 0.85) g.circle(x, y, 2.2).fill([0xffffff, 0xffe27a, 0xffb3d1, 0xc8b6ff][i % 4]);
      else g.ellipse(x, y, 4.5, 2.8).fill(0xe0ebcb);
    }
    for (const o of this.world.obstacles) this.drawObstacle(o);
  }

  /** Ponds, tree clumps and boulders (the sim treats each as a circle). */
  private drawObstacle(o: Obstacle): void {
    const g = this.ground;
    const rnd = (a: number, b: number): number => a + Math.random() * (b - a);
    if (o.kind === 'pond') {
      g.circle(o.x, o.y + 4, o.r + 8).fill(0xb3d98f);
      g.circle(o.x, o.y, o.r).fill(0x7ccaf0).stroke({ width: 6, color: 0x5cb4e2 });
      g.circle(o.x, o.y + o.r * 0.12, o.r * 0.82).fill({ color: 0x67bde9, alpha: 0.6 });
      g.ellipse(o.x - o.r * 0.32, o.y - o.r * 0.42, o.r * 0.3, o.r * 0.08).fill({ color: 0xffffff, alpha: 0.45 });
      for (let i = 0; i < 3; i++) {
        const a = rnd(0, Math.PI * 2);
        const d = rnd(0.35, 0.7) * o.r;
        const x = o.x + Math.cos(a) * d;
        const y = o.y + Math.sin(a) * d;
        g.circle(x, y, 9).fill(0x6fbf63).stroke({ width: 1.5, color: 0x4e9d4c });
        g.moveTo(x, y).lineTo(x + 9, y - 3).stroke({ width: 2, color: 0x67bde9 });
      }
    } else if (o.kind === 'trees') {
      g.ellipse(o.x, o.y + o.r * 0.55, o.r * 1.05, o.r * 0.45).fill({ color: 0x000000, alpha: 0.12 });
      const n = Math.max(4, Math.round(o.r / 11));
      const crowns: [number, number, number][] = [];
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2 + rnd(-0.3, 0.3);
        const d = o.r * rnd(0.3, 0.55);
        crowns.push([o.x + Math.cos(a) * d, o.y + Math.sin(a) * d * 0.85, o.r * rnd(0.4, 0.55)]);
      }
      crowns.push([o.x, o.y - o.r * 0.1, o.r * 0.55]);
      crowns.sort((a, b) => a[1] - b[1]);
      for (const [x, y, r] of crowns) {
        g.circle(x, y, r).fill(0x5bb05a).stroke({ width: 3, color: 0x3d8a44 });
        g.circle(x - r * 0.3, y - r * 0.3, r * 0.35).fill({ color: 0x86cf77, alpha: 0.8 });
      }
    } else {
      g.ellipse(o.x, o.y + o.r * 0.5, o.r, o.r * 0.4).fill({ color: 0x000000, alpha: 0.12 });
      const stones: [number, number, number][] = [
        [o.x - o.r * 0.35, o.y + o.r * 0.1, o.r * 0.6],
        [o.x + o.r * 0.3, o.y + o.r * 0.2, o.r * 0.5],
        [o.x, o.y - o.r * 0.25, o.r * 0.65],
      ];
      for (const [x, y, r] of stones) {
        g.circle(x, y, r).fill(0xbdb6ae).stroke({ width: 3, color: 0x8d857d });
        g.ellipse(x - r * 0.25, y - r * 0.35, r * 0.4, r * 0.18).fill({ color: 0xffffff, alpha: 0.4 });
      }
    }
  }

  // ───────────────────────────── per frame ─────────────────────────────

  render(
    alpha: number,
    now: number,
    dt: number,
    selected: ReadonlySet<number>,
    selectedBuilding: number | null,
    highlightTerritoryOf: number,
    fadeBlobs: boolean,
    /** All of one kind picked: a ring round each. */
    group: ReadonlySet<number> | null = null,
  ): void {
    const w = this.world;
    this.camera.resize(this.app.screen.width, this.app.screen.height);
    this.camera.apply(this.worldLayer);

    const fade = fadeBlobs ? FADED_BLOBS : 1;
    this.blobLayer.alpha += (fade - this.blobLayer.alpha) * Math.min(1, dt * 14);
    this.fxLayer.alpha = this.blobLayer.alpha;

    this.drawTerritory(highlightTerritoryOf);
    this.syncBuildings(now, selectedBuilding, group);
    this.drawRanges(selectedBuilding, group);

    const v = this.camera.view();
    const m = 60;
    for (const b of w.blobs) {
      let view = this.views.get(b.id);
      if (!view) {
        view = new BlobView(this.tx);
        this.views.set(b.id, view);
        this.blobLayer.addChild(view.root);
      }
      const onScreen = b.x > v.x0 - m && b.x < v.x1 + m && b.y > v.y0 - m && b.y < v.y1 + m;
      view.root.visible = onScreen;
      if (!onScreen) continue;
      const look = b.lookAt >= 0 ? w.byId.get(b.lookAt) : undefined;
      view.update(b, alpha, now, dt, w.factions[b.faction].color, selected.has(b.id), look);
    }
    for (const [id, view] of this.views) {
      if (!w.byId.has(id)) {
        view.destroy();
        this.views.delete(id);
      }
    }
    this.updateParticles(dt);
    this.drawMarks(dt);
  }

  /** Expanding ring where a group order landed. */
  pulse(x: number, y: number, r: number, color: number): void {
    this.pulses.push({ x, y, r, color, life: 0.9 });
  }

  private drawMarks(dt: number): void {
    const g = this.marks;
    g.clear();
    for (const p of this.pulses) {
      p.life -= dt;
      if (p.life <= 0) continue;
      const k = 1 - p.life / 0.9;
      g.circle(p.x, p.y, p.r * (0.6 + 0.4 * k)).stroke({ width: 4, color: p.color, alpha: 0.9 * (1 - k) });
    }
    if (this.pulses.length && this.pulses.every((p) => p.life <= 0)) this.pulses.length = 0;
    // Takeover progress bars above buildings.
    for (const b of this.world.buildings) {
      if (b.capture <= 0 || b.captureBy < 0) continue;
      const r = BUILDINGS[b.kind].radius;
      const y = b.y - r * 1.3 - 16;
      const by = this.world.factions[b.captureBy].color;
      g.circle(b.x, b.y, USURP_RADIUS + r).stroke({ width: 2, color: by, alpha: 0.5 });
      g.roundRect(b.x - 26, y - 4, 52, 8, 4).fill({ color: 0x3b2633, alpha: 0.8 });
      g.roundRect(b.x - 25, y - 3, 50 * b.capture, 6, 3).fill(by);
    }
  }

  private drawTerritory(highlight: number): void {
    const w = this.world;
    const key = `${w.buildingsVersion}:${w.factions.map((f) => f.tech).join(',')}:${highlight}`;
    if (key === this.territoryKey) return;
    this.territoryKey = key;
    const g = this.territory;
    g.clear();
    for (const b of w.buildings) {
      const r = w.territoryRadius(b.faction);
      const color = w.factions[b.faction].color;
      g.circle(b.x, b.y, r).fill({ color, alpha: b.faction === highlight ? 0.16 : 0.07 });
    }
    for (const b of w.buildings) {
      const r = w.territoryRadius(b.faction);
      const color = w.factions[b.faction].color;
      g.circle(b.x, b.y, r).stroke({ width: b.faction === highlight ? 4 : 2, color, alpha: b.faction === highlight ? 0.7 : 0.25 });
    }
  }

  private drawRanges(selectedBuilding: number | null, group: ReadonlySet<number> | null): void {
    const g = this.ranges;
    g.clear();
    if (group) {
      for (const b of this.world.buildings) {
        if (!group.has(b.id)) continue;
        const r = BUILDINGS[b.kind].radius * (1 + 0.05 * (b.level - 1));
        g.ellipse(b.x, b.y + r * 0.62, r * 1.45, r * 0.55).stroke({ width: 3, color: 0xffffff, alpha: 0.95 });
      }
      return;
    }
    if (selectedBuilding === null) return;
    const b = this.world.buildings.find((x) => x.id === selectedBuilding);
    if (!b) return;
    const color = this.world.factions[b.faction].color;
    if (b.kind === 'school') g.circle(b.x, b.y, schoolRadius(b)).stroke({ width: 3, color, alpha: 0.8 });
    if (b.kind === 'fountain') g.circle(b.x, b.y, fountainRadius(b)).fill({ color: 0xff8fc4, alpha: 0.08 }).stroke({ width: 3, color: 0xff8fc4, alpha: 0.8 });
    if (b.kind === 'police') {
      g.circle(b.x, b.y, policeDetectRadius(this.world.factions[b.faction].tech)).stroke({ width: 3, color: 0x3b6cff, alpha: 0.7 });
    }
  }

  private syncBuildings(now: number, selected: number | null, group: ReadonlySet<number> | null): void {
    for (const b of this.world.buildings) {
      let v = this.bviews.get(b.id);
      if (v && v.faction !== b.faction) {
        // Taken over: repaint in the new owner's colours.
        v.root.destroy({ children: true });
        this.bviews.delete(b.id);
        v = undefined;
      }
      if (!v) {
        v = this.makeBuildingView(b.kind, this.world.factions[b.faction].color);
        v.faction = b.faction;
        v.root.position.set(b.x, b.y);
        v.root.zIndex = b.y;
        this.buildingLayer.addChild(v.root);
        this.bviews.set(b.id, v);
      }
      if (v.level !== b.level) this.drawLevel(v, b);
      v.root.scale.set((selected === b.id || group?.has(b.id) ? 1.08 : 1) * (1 + 0.05 * (b.level - 1)));
      if (v.light) v.light.tint = Math.floor(now / 400) % 2 === 0 ? 0xff4d4d : 0x4d7bff;
    }
  }

  private makeBuildingView(kind: BuildingKind, color: number): BuildingView {
    const r = BUILDINGS[kind].radius;
    const root = new Container();
    const g = new Graphics()
      .ellipse(0, r * 0.62, r * 1.15, r * 0.36)
      .fill({ color: 0x000000, alpha: 0.15 })
      .roundRect(-r * 0.92, -r * 0.45, r * 1.84, r * 1.1, 7)
      .fill(0xfff6e6)
      .stroke({ width: 2.5, color: OUTLINE })
      .poly([-r * 1.12, -r * 0.38, 0, -r * 1.3, r * 1.12, -r * 0.38])
      .fill(color)
      .stroke({ width: 2.5, color: OUTLINE, join: 'round' });
    root.addChild(g);
    const icon = new Sprite(this.tx.emoji(BUILDINGS[kind].icon));
    icon.anchor.set(0.5);
    icon.position.set(0, r * 0.1);
    icon.scale.set((r * 0.95) / 48);
    root.addChild(icon);
    let light: Graphics | undefined;
    if (kind === 'police') {
      light = new Graphics().roundRect(-5, -4, 10, 8, 3).fill(0xffffff);
      light.position.set(0, -r * 1.32);
      root.addChild(light);
    }
    const stars = new Container();
    root.addChild(stars);
    return { root, light, faction: -1, level: 1, stars };
  }

  /** A row of stars along the front of a building that has been levelled up. */
  private drawLevel(v: BuildingView, b: Building): void {
    v.level = b.level;
    for (const s of v.stars.removeChildren()) s.destroy();
    const y = BUILDINGS[b.kind].radius * 0.72;
    for (let i = 0; i < b.level && b.level > 1; i++) {
      const star = new Sprite(this.tx.emoji('⭐'));
      star.anchor.set(0.5);
      star.scale.set(0.24);
      star.position.set((i - (b.level - 1) / 2) * 11, y);
      v.stars.addChild(star);
    }
  }

  // ───────────────────────────── build ghost & selection box ─────────────────────────────

  setGhost(kind: BuildingKind | null, x = 0, y = 0, ok = true, color = 0xffffff): void {
    if (kind !== this.ghostKind) {
      this.ghost.removeChildren().forEach((c) => c.destroy({ children: true }));
      this.ghostKind = kind;
      if (kind) this.ghost.addChild(this.makeBuildingView(kind, color).root);
    }
    this.ghost.visible = !!kind;
    if (!kind) return;
    this.ghost.position.set(x, y);
    this.ghost.tint = ok ? 0xffffff : 0xff6666;
  }

  setBox(box: { x0: number; y0: number; x1: number; y1: number } | null): void {
    const g = this.overlay;
    g.clear();
    if (!box) return;
    const x = Math.min(box.x0, box.x1);
    const y = Math.min(box.y0, box.y1);
    g.rect(x, y, Math.abs(box.x1 - box.x0), Math.abs(box.y1 - box.y0))
      .fill({ color: 0xffffff, alpha: 0.12 })
      .stroke({ width: 2, color: 0xffffff, alpha: 0.9 });
  }

  // ───────────────────────────── effects ─────────────────────────────

  fx(events: readonly SimEvent[]): void {
    for (const e of events) {
      switch (e.type) {
        case 'talk':
          this.spawn('💬', e.x, e.y - 22, 0.3, 0.9);
          break;
        case 'teach':
          this.spawn('📚', e.x, e.y - 24, 0.34, 1.0);
          break;
        case 'taught':
          this.spawn('✨', e.x, e.y - 20, 0.45, 1.1);
          break;
        case 'convert':
          for (let i = 0; i < 3; i++) this.spawn('💗', e.x + (i - 1) * 10, e.y - 20, 0.42, 1.4, (i - 1) * 18);
          this.spawn('✨', e.x, e.y - 8, 0.5, 0.9);
          break;
        case 'fearConvert':
          this.spawn('😨', e.x, e.y - 24, 0.45, 1.3);
          break;
        case 'defect':
          this.spawn('💨', e.x, e.y - 18, 0.45, 1.2);
          break;
        case 'hit':
          this.spawn('💥', e.x + (Math.random() - 0.5) * 10, e.y - 14, 0.5, 0.6);
          break;
        case 'kill':
        case 'death':
          this.spawn('👻', e.x, e.y - 10, e.type === 'kill' ? 0.6 : 0.45, 2.2);
          break;
        case 'arrest':
          this.spawn('🚨', e.x, e.y - 30, 0.55, 1.4);
          this.spawn('🔒', e.x + 14, e.y - 14, 0.4, 1.4);
          break;
        case 'escape':
          this.spawn('💨', e.x, e.y - 10, 0.35, 0.7);
          break;
        case 'birth':
          this.spawn('🐣', e.x, e.y - 18, 0.45, 1.5);
          break;
        case 'release':
          this.spawn('🕊️', e.x, e.y - 20, 0.4, 1.4);
          break;
        case 'build':
          for (let i = 0; i < 4; i++) this.spawn('✨', e.x + (Math.random() - 0.5) * 50, e.y - Math.random() * 30, 0.4, 1);
          break;
        case 'upgrade':
          for (let i = 0; i < 6; i++) this.spawn('⭐', e.x + (Math.random() - 0.5) * 60, e.y - Math.random() * 40, 0.4, 1.1);
          break;
        case 'tech':
          this.spawn('💡', e.x, e.y - 60, 0.9, 2.2);
          break;
        case 'recruit':
          this.spawn('⭐', e.x, e.y - 26, 0.4, 1.2);
          break;
        case 'usurp':
          this.spawn('🏳️', e.x, e.y - 50, 0.7, 2);
          for (let i = 0; i < 5; i++) this.spawn('✨', e.x + (Math.random() - 0.5) * 60, e.y - Math.random() * 40, 0.4, 1.2);
          break;
        case 'usurping':
          this.spawn('🏳️', e.x, e.y - 50, 0.5, 1.4);
          break;
        case 'notice':
          break;
      }
    }
  }

  private spawn(char: string, x: number, y: number, scale: number, life: number, vx = 0): void {
    let p = this.particles.find((q) => q.life <= 0);
    if (!p) {
      const s = new Sprite();
      s.anchor.set(0.5);
      this.fxLayer.addChild(s);
      p = { s, vx: 0, vy: 0, life: 0, max: 1, scale: 1 };
      this.particles.push(p);
    }
    p.s.texture = this.tx.emoji(char);
    p.s.position.set(x, y);
    p.s.visible = true;
    p.vx = vx;
    p.vy = -28;
    p.life = p.max = life;
    p.scale = scale;
  }

  private updateParticles(dt: number): void {
    for (const p of this.particles) {
      if (p.life <= 0) continue;
      p.life -= dt;
      if (p.life <= 0) {
        p.s.visible = false;
        continue;
      }
      const k = 1 - p.life / p.max;
      p.s.x += p.vx * dt;
      p.s.y += p.vy * dt;
      p.vy *= 0.97;
      p.s.alpha = k < 0.7 ? 1 : 1 - (k - 0.7) / 0.3;
      p.s.scale.set(p.scale * (k < 0.15 ? 0.6 + (k / 0.15) * 0.4 : 1));
    }
  }

  /** Building nearest a world point within its radius. */
  /** The building at a point, if any. `slack` is how far outside its edge still counts. */
  buildingAt(x: number, y: number, slack = 6): Building | undefined {
    let best: Building | undefined;
    let bd = Infinity;
    for (const b of this.world.buildings) {
      const r = BUILDINGS[b.kind].radius + slack;
      const d = (b.x - x) ** 2 + (b.y - y) ** 2;
      if (d < r * r && d < bd) {
        bd = d;
        best = b;
      }
    }
    return best;
  }
}
