import type { Blob } from './types';

/** Uniform spatial hash for neighbour queries. Rebuilt every tick. */
export class Grid {
  private readonly cols: number;
  private readonly rows: number;
  private readonly cells: Blob[][];

  constructor(w: number, h: number, private readonly size = 64) {
    this.cols = Math.ceil(w / size) + 1;
    this.rows = Math.ceil(h / size) + 1;
    this.cells = Array.from({ length: this.cols * this.rows }, () => []);
  }

  rebuild(blobs: readonly Blob[]): void {
    for (const c of this.cells) c.length = 0;
    for (const b of blobs) {
      if (!b.alive) continue;
      this.cells[this.index(b.x, b.y)].push(b);
    }
  }

  /** Fill `out` with alive blobs within radius r of (x, y). */
  query(x: number, y: number, r: number, out: Blob[]): Blob[] {
    out.length = 0;
    const s = this.size;
    const c0 = Math.max(0, Math.floor((x - r) / s));
    const c1 = Math.min(this.cols - 1, Math.floor((x + r) / s));
    const r0 = Math.max(0, Math.floor((y - r) / s));
    const r1 = Math.min(this.rows - 1, Math.floor((y + r) / s));
    const rr = r * r;
    for (let row = r0; row <= r1; row++) {
      for (let col = c0; col <= c1; col++) {
        for (const b of this.cells[row * this.cols + col]) {
          const dx = b.x - x;
          const dy = b.y - y;
          if (dx * dx + dy * dy <= rr && b.alive) out.push(b);
        }
      }
    }
    return out;
  }

  private index(x: number, y: number): number {
    const col = Math.min(this.cols - 1, Math.max(0, Math.floor(x / this.size)));
    const row = Math.min(this.rows - 1, Math.max(0, Math.floor(y / this.size)));
    return row * this.cols + col;
  }
}
