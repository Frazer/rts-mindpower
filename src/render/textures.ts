import { Graphics, Text, type Renderer, type Texture } from 'pixi.js';

/** All blob art is drawn in code at body radius 32, then reused as textures. */
export interface Textures {
  body: Texture;
  shine: Texture;
  shadow: Texture;
  eyeWhite: Texture;
  pupil: Texture;
  smile: Texture;
  grin: Texture;
  flat: Texture;
  frown: Texture;
  ohh: Texture;
  brows: Texture;
  blush: Texture;
  policeHat: Texture;
  flower: Texture;
  ring: Texture;
  bars: Texture;
  emoji: (char: string) => Texture;
}

const INK = 0x3b2633;

/** Polyline arc (robust across Graphics path quirks). */
function arc(g: Graphics, cx: number, cy: number, r: number, a0: number, a1: number, steps = 14): Graphics {
  for (let i = 0; i <= steps; i++) {
    const a = a0 + ((a1 - a0) * i) / steps;
    const x = cx + Math.cos(a) * r;
    const y = cy + Math.sin(a) * r;
    if (i === 0) g.moveTo(x, y);
    else g.lineTo(x, y);
  }
  return g;
}

export function makeTextures(renderer: Renderer): Textures {
  const tex = (g: Graphics): Texture => {
    const t = renderer.generateTexture({ target: g, resolution: 2, antialias: true });
    g.destroy();
    return t;
  };

  // Body: white so it can be tinted per faction. Grey belly shade + darker rim read as shading once tinted.
  const body = new Graphics()
    .ellipse(0, 0, 32, 29)
    .fill(0xffffff)
    .stroke({ width: 3, color: 0x9a9a9a })
    .ellipse(0, 11, 24, 14)
    .fill({ color: 0xe2e2e2, alpha: 0.9 });

  const shine = new Graphics().ellipse(0, 0, 9, 5.5).fill({ color: 0xffffff, alpha: 0.75 });
  const shadow = new Graphics().ellipse(0, 0, 30, 9).fill({ color: 0x000000, alpha: 0.16 });

  const eyeWhite = new Graphics().circle(0, 0, 7.5).fill(0xffffff).stroke({ width: 1.6, color: INK });
  const pupil = new Graphics().circle(0, 0, 3.8).fill(INK).circle(-1.2, -1.3, 1.3).fill(0xffffff);

  const line = { width: 2.8, color: INK, cap: 'round' as const, join: 'round' as const };
  const smile = arc(new Graphics(), 0, -3, 7, 0.2 * Math.PI, 0.8 * Math.PI).stroke(line);
  const grin = arc(new Graphics(), 0, -4, 8, 0.1 * Math.PI, 0.9 * Math.PI).closePath().fill(0x8a2a45).stroke(line);
  const flat = new Graphics().moveTo(-5, 0).lineTo(5, 0).stroke(line);
  const frown = arc(new Graphics(), 0, 6, 7, 1.2 * Math.PI, 1.8 * Math.PI).stroke(line);
  const ohh = new Graphics().ellipse(0, 0, 3.6, 4.4).fill(INK);

  const brows = new Graphics()
    .moveTo(-15, -4)
    .lineTo(-5, 1)
    .moveTo(15, -4)
    .lineTo(5, 1)
    .stroke({ width: 3.4, color: INK, cap: 'round' });

  const blush = new Graphics()
    .ellipse(-17, 0, 5, 3)
    .fill({ color: 0xff6f91, alpha: 0.45 })
    .ellipse(17, 0, 5, 3)
    .fill({ color: 0xff6f91, alpha: 0.45 });

  const policeHat = new Graphics()
    .roundRect(-15, -12, 30, 14, 6)
    .fill(0x2d4a9a)
    .stroke({ width: 1.5, color: 0x1a2c5e })
    .ellipse(0, 2, 20, 4.5)
    .fill(0x1f356f)
    .star(0, -5, 5, 4, 2)
    .fill(0xffd34d);

  const flower = new Graphics();
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * Math.PI * 2;
    flower.circle(Math.cos(a) * 5, Math.sin(a) * 5, 4).fill(0xff8fc4);
  }
  flower.circle(0, 0, 3.5).fill(0xffe066);

  const ring = new Graphics()
    .ellipse(0, 0, 40, 15)
    .fill({ color: 0xffe14d, alpha: 0.35 })
    .stroke({ width: 6, color: 0xffe14d });

  const bars = new Graphics();
  bars.roundRect(-30, -34, 60, 66, 8).stroke({ width: 3, color: 0x555566 });
  for (let x = -18; x <= 18; x += 12) bars.moveTo(x, -34).lineTo(x, 32);
  bars.stroke({ width: 3, color: 0x555566 });

  const emojiCache = new Map<string, Texture>();
  const emoji = (char: string): Texture => {
    let t = emojiCache.get(char);
    if (!t) {
      const txt = new Text({ text: char, style: { fontSize: 48, fontFamily: 'Apple Color Emoji, Segoe UI Emoji, Noto Color Emoji, sans-serif' } });
      t = renderer.generateTexture({ target: txt, resolution: 1 });
      txt.destroy();
      emojiCache.set(char, t);
    }
    return t;
  };

  return {
    body: tex(body),
    shine: tex(shine),
    shadow: tex(shadow),
    eyeWhite: tex(eyeWhite),
    pupil: tex(pupil),
    smile: tex(smile),
    grin: tex(grin),
    flat: tex(flat),
    frown: tex(frown),
    ohh: tex(ohh),
    brows: tex(brows),
    blush: tex(blush),
    policeHat: tex(policeHat),
    flower: tex(flower),
    ring: tex(ring),
    bars: tex(bars),
    emoji,
  };
}
