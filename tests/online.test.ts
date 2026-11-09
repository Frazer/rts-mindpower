/// <reference types="node" />
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MODES } from '../src/modes';
import { DT, NEUTRAL } from '../src/sim/config';
import { cos, sin } from '../src/sim/util';
import { World } from '../src/sim/world';

const run = (w: World, seconds: number): void => {
  for (let i = 0; i < Math.round(seconds / DT) && !w.outcome; i++) {
    w.tick(DT);
    w.drainEvents();
  }
};

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(join(dir, e.name)) : [join(dir, e.name)]));
}

describe('online play', () => {
  it('sim code avoids maths that can differ between browsers', () => {
    for (const f of files('src/sim')) {
      const code = readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
      expect(code, f).not.toMatch(/Math\.(sin|cos|tan|asin|acos|atan2?|exp|expm1|log\w*|pow|hypot|cbrt|sinh|cosh|tanh|random)\b/);
    }
  });

  it('own sin and cos match Math', () => {
    for (let x = -20; x <= 20; x += 0.01) {
      expect(Math.abs(sin(x) - Math.sin(x))).toBeLessThan(1e-10);
      expect(Math.abs(cos(x) - Math.cos(x))).toBeLessThan(1e-10);
    }
  });

  it('same seed and orders give the same game', () => {
    const a = new World(MODES.pro, 5, { rivals: 3, humans: [1, 3] });
    const b = new World(MODES.pro, 5, { rivals: 3, humans: [1, 3] });
    for (const w of [a, b]) {
      const mine = w.blobs.find((x) => x.faction === 3)!;
      const wild = w.blobs.find((x) => x.faction === NEUTRAL)!;
      w.command({ type: 'order', faction: 3, ids: [mine.id], order: 'befriend', target: wild.id });
      run(w, 120);
    }
    expect(a.hash()).toBe(b.hash());
  });

  it('a loaded snapshot carries on exactly like the original', () => {
    const a = new World(MODES.casual, 9, { rivals: 4 });
    run(a, 90);
    const b = new World(MODES.casual, 9, { rivals: 4 });
    b.load(a.save());
    expect(b.hash()).toBe(a.hash());
    run(a, 120);
    run(b, 120);
    expect(b.hash()).toBe(a.hash());
    expect(b.save()).toBe(a.save());
  });

  it('a drifted copy is caught by the fingerprint', () => {
    const a = new World(MODES.casual, 4);
    const b = new World(MODES.casual, 4);
    run(a, 10);
    run(b, 10);
    expect(b.hash()).toBe(a.hash());
    b.blobs[3].x += 1e-9;
    expect(b.hash()).not.toBe(a.hash());
  });

  it('human teams have no AI until the computer takes over', () => {
    const w = new World(MODES.pro, 2, { rivals: 2, humans: [1, 2] });
    expect(w.factions.map((f) => [f.isPlayer, !!f.ai])).toEqual([
      [false, false],
      [true, false],
      [true, false],
      [false, true],
    ]);
    w.command({ type: 'setAi', faction: 2, on: true });
    w.tick(DT);
    expect(w.factions[2].ai).not.toBeNull();
  });
});
