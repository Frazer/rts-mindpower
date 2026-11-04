import type { Container } from 'pixi.js';
import { clamp } from '../sim/util';

/** Camera centred on (x, y) in world units. */
export class Camera {
  x = 0;
  y = 0;
  zoom = 1;
  minZoom = 0.3;
  maxZoom = 2.6;
  sw = 1;
  sh = 1;

  constructor(private readonly worldW: number, private readonly worldH: number) {}

  resize(sw: number, sh: number): void {
    this.sw = sw;
    this.sh = sh;
    // Never let the user zoom out so far that the world is a dot.
    this.minZoom = Math.min(0.8, Math.max(0.2, Math.min(sw / this.worldW, sh / this.worldH) * 0.9));
  }

  apply(c: Container): void {
    this.zoom = clamp(this.zoom, this.minZoom, this.maxZoom);
    this.x = clamp(this.x, 0, this.worldW);
    this.y = clamp(this.y, 0, this.worldH);
    c.scale.set(this.zoom);
    c.position.set(this.sw / 2 - this.x * this.zoom, this.sh / 2 - this.y * this.zoom);
  }

  toWorld(sx: number, sy: number): { x: number; y: number } {
    return { x: (sx - this.sw / 2) / this.zoom + this.x, y: (sy - this.sh / 2) / this.zoom + this.y };
  }

  toScreen(wx: number, wy: number): { x: number; y: number } {
    return { x: (wx - this.x) * this.zoom + this.sw / 2, y: (wy - this.y) * this.zoom + this.sh / 2 };
  }

  pan(dsx: number, dsy: number): void {
    this.x -= dsx / this.zoom;
    this.y -= dsy / this.zoom;
  }

  /** Zoom keeping the world point under (sx, sy) fixed. */
  zoomAt(sx: number, sy: number, factor: number): void {
    const before = this.toWorld(sx, sy);
    this.zoom = clamp(this.zoom * factor, this.minZoom, this.maxZoom);
    const after = this.toWorld(sx, sy);
    this.x += before.x - after.x;
    this.y += before.y - after.y;
  }

  /** World-space rectangle currently on screen. */
  view(): { x0: number; y0: number; x1: number; y1: number } {
    const a = this.toWorld(0, 0);
    const b = this.toWorld(this.sw, this.sh);
    return { x0: a.x, y0: a.y, x1: b.x, y1: b.y };
  }
}
