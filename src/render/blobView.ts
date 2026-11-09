import { Container, Sprite, Texture } from 'pixi.js';
import { ADULT_AGE } from '../sim/config';
import type { Blob } from '../sim/types';
import { lerp } from '../sim/util';
import type { Textures } from './textures';

const FEET = 29;

function sprite(t: Texture, x = 0, y = 0): Sprite {
  const s = new Sprite(t);
  s.anchor.set(0.5);
  s.position.set(x, y);
  return s;
}

/** One cartoon blob: tinted body, googly eyes, mood mouth, role hats. */
export class BlobView {
  readonly root = new Container();
  private readonly bodyGroup = new Container();
  private readonly body: Sprite;
  private readonly ring: Sprite;
  private readonly eyes: Sprite[];
  private readonly pupils: Sprite[];
  private readonly mouth: Sprite;
  private readonly brows: Sprite;
  private readonly blush: Sprite;
  private readonly hat: Sprite;
  private readonly flower: Sprite;
  private readonly cap: Sprite;
  private readonly bars: Sprite;
  private readonly status: Sprite;
  private readonly hpBack: Sprite;
  private readonly hpFill: Sprite;
  private readonly phase = Math.random() * 100;
  private blink = 1 + Math.random() * 4;
  private pop = 0;
  private lastFaction = -1;
  private lastHealth = 1;
  private flash = 0;
  private statusChar = '';

  constructor(private readonly tx: Textures) {
    const shadow = sprite(tx.shadow, 0, FEET);
    this.ring = sprite(tx.ring, 0, FEET);
    this.ring.visible = false;

    this.bodyGroup.pivot.set(0, FEET);
    this.bodyGroup.position.set(0, FEET);
    this.body = sprite(tx.body);
    const shine = sprite(tx.shine, -13, -15);
    shine.rotation = -0.5;
    this.blush = sprite(tx.blush, 0, 5);
    this.eyes = [sprite(tx.eyeWhite, -10, -5), sprite(tx.eyeWhite, 10, -5)];
    this.pupils = [sprite(tx.pupil, -10, -5), sprite(tx.pupil, 10, -5)];
    this.brows = sprite(tx.brows, 0, -15);
    this.mouth = sprite(tx.smile, 0, 10);
    this.hat = sprite(tx.policeHat, 0, -29);
    this.flower = sprite(tx.flower, 17, -24);
    this.cap = sprite(tx.emoji('🎓'), 0, -31);
    this.cap.scale.set(0.5);
    this.bodyGroup.addChild(this.body, shine, this.blush, ...this.eyes, ...this.pupils, this.brows, this.mouth, this.hat, this.flower, this.cap);

    this.bars = sprite(tx.bars, 0, 0);
    this.status = sprite(Texture.EMPTY, 0, -58);
    this.status.scale.set(0.5);
    this.hpBack = sprite(Texture.WHITE, 0, -44);
    this.hpBack.tint = 0x3b2633;
    this.hpBack.width = 44;
    this.hpBack.height = 7;
    this.hpFill = new Sprite(Texture.WHITE);
    this.hpFill.anchor.set(0, 0.5);
    this.hpFill.position.set(-21, -44);
    this.hpFill.height = 4;

    this.root.addChild(shadow, this.ring, this.bodyGroup, this.bars, this.status, this.hpBack, this.hpFill);
  }

  update(b: Blob, alpha: number, now: number, dt: number, color: number, selected: boolean, look: Blob | undefined): void {
    const x = lerp(b.px, b.x, alpha);
    const y = lerp(b.py, b.y, alpha);
    this.root.position.set(x, y);
    this.root.zIndex = y;

    if (this.lastFaction !== b.faction) {
      if (this.lastFaction !== -1) this.pop = 0.6;
      this.lastFaction = b.faction;
    }
    if (b.health < this.lastHealth - 0.01) this.flash = 0.25;
    this.lastHealth = b.health;
    this.pop = Math.max(0, this.pop - dt);
    this.flash = Math.max(0, this.flash - dt);

    const grow = 0.55 + 0.45 * Math.min(1, b.age / ADULT_AGE);
    const popScale = 1 + Math.sin((this.pop / 0.6) * Math.PI) * 0.35;
    const size = ((11 + 5 * Math.min(2, b.traits.strength)) * grow * popScale) / 32;
    this.root.scale.set(size);

    // Hop when moving, breathe when idle.
    const t = now * 0.001 + this.phase;
    const speed = Math.hypot(b.vx, b.vy);
    let sx = 1;
    let sy = 1;
    let hop = 0;
    if (b.jail > 0) {
      sy = 0.92;
      sx = 1.06;
    } else if (speed > 6) {
      const f = 7 + 6 * Math.min(1.5, b.traits.fitness);
      const s = Math.sin(t * f);
      hop = Math.abs(s) * Math.min(1, speed / 30) * 8;
      const sq = Math.cos(t * f * 2) * 0.07;
      sx = 1 + sq;
      sy = 1 - sq;
    } else {
      const br = Math.sin(t * 2.2) * 0.035;
      sx = 1 + br;
      sy = 1 - br;
    }
    this.bodyGroup.position.y = FEET - hop;
    this.bodyGroup.scale.set(sx, sy);

    this.body.tint = this.flash > 0 ? 0xff5555 : color;

    // Eyes look where they're going, or at whoever they're talking to.
    let lx = b.vx;
    let ly = b.vy;
    if (look && speed < 10) {
      lx = look.x - b.x;
      ly = look.y - b.y;
    }
    const ll = Math.hypot(lx, ly);
    const ox = ll > 0.5 ? (lx / ll) * 2.6 : 0;
    const oy = ll > 0.5 ? (ly / ll) * 2.2 : 0;
    this.blink -= dt;
    if (this.blink < -0.12) this.blink = 2 + Math.random() * 4;
    const eyeY = this.blink < 0 || b.mood === 'sad' ? 0.15 : 1;
    for (let i = 0; i < 2; i++) {
      this.eyes[i].scale.y = eyeY;
      this.pupils[i].visible = eyeY > 0.5;
      this.pupils[i].position.set((i === 0 ? -10 : 10) + ox, -5 + oy);
    }

    const tx = this.tx;
    switch (b.mood) {
      case 'happy':
        this.mouth.texture = tx.grin;
        break;
      case 'angry':
      case 'sad':
        this.mouth.texture = tx.frown;
        break;
      case 'scared':
        this.mouth.texture = tx.ohh;
        break;
      default:
        this.mouth.texture = b.traits.kindness > 0.55 ? tx.smile : b.traits.violence > 0.62 ? tx.frown : tx.flat;
    }
    this.brows.visible = b.mood === 'angry' || (b.traits.violence > 0.66 && b.mood !== 'happy');
    this.blush.visible = b.traits.kindness > 0.62 || b.mood === 'happy';
    this.hat.visible = b.role === 'police';
    this.flower.visible = b.role === 'ambassador' || b.job === 'recruiter';
    this.cap.visible = b.job === 'teacher' && b.role !== 'police';
    this.bars.visible = b.jail > 0;
    this.ring.visible = selected;

    const char = b.heat > 0 && b.jail <= 0 ? '🚨' : '';
    if (char !== this.statusChar) {
      this.statusChar = char;
      this.status.texture = char ? tx.emoji(char) : Texture.EMPTY;
    }
    this.status.visible = !!char;
    if (char) this.status.y = -60 + Math.sin(t * 8) * 3;

    const showHp = b.health < 0.98;
    this.hpBack.visible = this.hpFill.visible = showHp;
    if (showHp) {
      this.hpFill.width = 42 * Math.max(0, b.health);
      this.hpFill.tint = b.health > 0.5 ? 0x7ad36b : b.health > 0.25 ? 0xffc145 : 0xff5a5a;
    }
  }

  destroy(): void {
    this.root.destroy({ children: true });
  }
}
