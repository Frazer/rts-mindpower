import { describe, expect, it } from 'vitest';
import { MODES } from '../src/modes';
import { DT } from '../src/sim/config';
import { HISTORY_FIELDS, World } from '../src/sim/world';

const run = (w: World, seconds: number): void => {
  for (let i = 0; i < Math.round(seconds / DT) && !w.outcome; i++) {
    w.tick(DT);
    w.drainEvents();
  }
};

describe('game history for the end charts', () => {
  it('records every team every few seconds, from the start', () => {
    const w = new World(MODES.casual, 3, { victory: false });
    const teams = w.factions.length;
    expect(w.history.rows).toHaveLength(1);
    run(w, 60);
    const rows = w.history.rows;
    expect(rows.length).toBeGreaterThanOrEqual(12);
    expect(rows.length).toBeLessThanOrEqual(13);
    for (const r of rows) expect(r).toHaveLength(1 + teams * HISTORY_FIELDS);
    const last = rows.at(-1)!;
    w.refreshCounts();
    // Blobs match the live count, and gold earned only goes up.
    for (const f of w.factions) {
      expect(last[1 + f.id * HISTORY_FIELDS]).toBe(f.pop);
      expect(last[2 + f.id * HISTORY_FIELDS]).toBe(f.earned);
    }
    const p = w.factions[1];
    expect(p.earned).toBeGreaterThan(0);
    expect(rows.map((r) => r[2 + HISTORY_FIELDS])).toEqual([...rows.map((r) => r[2 + HISTORY_FIELDS])].sort((a, b) => a - b));
  });

  it('stays small in a long game', () => {
    const w = new World(MODES.casual, 4, { victory: false });
    run(w, 60 * 25);
    const rows = w.history.rows;
    expect(rows.length).toBeLessThanOrEqual(241);
    expect(w.history.every).toBeGreaterThan(5);
    // Still covers the whole game, evenly.
    expect(rows[0][0]).toBe(0);
    expect(rows.at(-1)![0]).toBeGreaterThan(60 * 25 - w.history.every * 1.01);
    const gaps = rows.slice(1).map((r, i) => r[0] - rows[i][0]);
    for (const g of gaps) expect(g).toBeCloseTo(w.history.every, 3);
  });

  it('travels with the copy of the game a player catches up from', () => {
    const a = new World(MODES.casual, 9);
    run(a, 30);
    const b = new World(MODES.casual, 9);
    b.load(a.save());
    expect(b.history).toEqual(a.history);
    run(a, 10);
    run(b, 10);
    expect(b.history).toEqual(a.history);
  });
});
