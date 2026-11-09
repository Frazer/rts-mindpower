/// <reference types="node" />
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { attachRelay } from '../server/relay';
import { MODES } from '../src/modes';
import { Connection } from '../src/net/client';
import { Lockstep } from '../src/net/lockstep';
import type { ServerMsg } from '../src/net/protocol';
import { NEUTRAL } from '../src/sim/config';
import type { Command } from '../src/sim/types';
import { World } from '../src/sim/world';

let server: Server | undefined;
let url = '';

beforeAll(async () => {
  // RELAY_TEST_URL runs these against another relay, such as `npm run relay:cf`.
  if (process.env.RELAY_TEST_URL) {
    url = process.env.RELAY_TEST_URL;
    return;
  }
  const local = createServer();
  server = local;
  attachRelay(local);
  await new Promise<void>((r) => local.listen(0, r));
  url = `ws://127.0.0.1:${(local.address() as AddressInfo).port}/relay`;
});
afterAll(() => {
  server?.closeAllConnections();
  server?.close();
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A headless player: a connection, and a world that plays the relay's turns. */
class Bot {
  conn!: Connection;
  msgs: ServerMsg[] = [];
  world: World | null = null;
  ls: Lockstep | null = null;
  team = 0;
  token = '';
  code = '';
  snaps = 0;
  /** Every order that came in a turn. */
  cmds: Command[] = [];

  async open(): Promise<this> {
    this.conn = await Connection.open(url);
    this.conn.onMsg = (m) => this.on(m);
    return this;
  }

  on(m: ServerMsg): void {
    this.msgs.push(m);
    if (m.t === 'joined') {
      this.token = m.token;
      this.code = m.lobby.code;
    } else if (m.t === 'start') {
      this.team = m.team;
      const s = m.setup;
      this.world = new World(MODES[s.mode], s.seed, { rivals: s.rivals, humans: s.humans, names: s.names });
      this.ls = new Lockstep(
        this.world,
        { hash: (n, h) => this.conn.send({ t: 'hash', n, h }), snap: (n, data) => this.conn.send({ t: 'snap', n, data }) },
        m.resume,
      );
    } else if (m.t === 'turn') {
      this.cmds.push(...m.turn.c);
      this.ls?.add(m.turn);
      this.ls?.step(1e6);
    } else if (m.t === 'snap') {
      this.snaps++;
      this.ls?.load(m.n, m.data, m.turns);
      this.ls?.step(1e6);
    } else if (m.t === 'snapReq') {
      this.ls?.requestSnap();
    }
  }

  async wait(t: ServerMsg['t'], ms = 3000): Promise<ServerMsg> {
    const end = Date.now() + ms;
    for (;;) {
      const i = this.msgs.findIndex((m) => m.t === t);
      if (i >= 0) return this.msgs.splice(i, 1)[0];
      if (Date.now() > end) throw new Error(`no ${t}`);
      await sleep(10);
    }
  }
}

/** Pause the game and let both players finish every turn sent. */
async function settle(host: Bot, ...others: Bot[]): Promise<void> {
  host.conn.send({ t: 'pace', paused: true });
  await sleep(400);
  const done = [host, ...others].map((b) => b.ls!.done);
  expect(new Set(done).size).toBe(1);
}

describe('online relay', () => {
  it('two players stay in step, a drifted one is put back, and a dropped one can rejoin', async () => {
    const ann = await new Bot().open();
    ann.conn.send({ t: 'create', name: 'Ann' });
    await ann.wait('joined');
    const bob = await new Bot().open();
    bob.conn.send({ t: 'join', code: ann.code, name: 'Bob' });
    const joined = (await bob.wait('joined')) as Extract<ServerMsg, { t: 'joined' }>;
    expect(joined.lobby.slots[1].player).toBe(joined.you);

    ann.conn.send({ t: 'settings', mode: 'pro', slots: ['open', 'open', 'ai', 'ai'] });
    await sleep(100);
    ann.conn.send({ t: 'start' });
    await ann.wait('start');
    await bob.wait('start');
    expect([ann.team, bob.team]).toEqual([1, 2]);
    expect(ann.world!.factions.map((f) => f.name)).toEqual(['Wanderers', 'Ann', 'Bob', 'Grumble Gang', 'Minty Minds']);

    // Bob orders a blob about; it reaches both games through the relay.
    await sleep(300);
    const w = bob.world!;
    const mine = w.blobs.find((b) => b.faction === 2)!;
    const wild = w.blobs.find((b) => b.faction === NEUTRAL)!;
    bob.conn.send({ t: 'cmd', c: { type: 'order', faction: 1, ids: [mine.id], order: 'befriend', target: wild.id } });
    await sleep(1000);
    // It arrives as Bob's team, whatever team the message claimed.
    for (const b of [ann, bob]) {
      expect(b.cmds).toContainEqual({ type: 'order', faction: 2, ids: [mine.id], order: 'befriend', target: wild.id });
    }
    await settle(ann, bob);
    expect(bob.world!.hash()).toBe(ann.world!.hash());

    // Bob's game drifts; the fingerprint check notices and the host's copy fixes it.
    bob.world!.blobs[5].x += 0.5;
    expect(bob.world!.hash()).not.toBe(ann.world!.hash());
    ann.conn.send({ t: 'pace', paused: false });
    for (let i = 0; i < 60 && bob.snaps === 0; i++) await sleep(100);
    expect(bob.snaps).toBe(1);
    await settle(ann, bob);
    expect(bob.world!.hash()).toBe(ann.world!.hash());

    // Bob drops out and comes back with his token.
    ann.conn.send({ t: 'pace', paused: false });
    const token = bob.token;
    bob.conn.close();
    await sleep(500);
    const bob2 = await new Bot().open();
    bob2.conn.send({ t: 'join', code: ann.code, name: 'Bob', token });
    await bob2.wait('joined');
    const start = (await bob2.wait('start')) as Extract<ServerMsg, { t: 'start' }>;
    expect(start.resume).toBe(true);
    expect(bob2.team).toBe(2);
    for (let i = 0; i < 60 && bob2.snaps === 0; i++) await sleep(100);
    expect(bob2.snaps).toBe(1);
    await sleep(300);
    await settle(ann, bob2);
    expect(bob2.world!.hash()).toBe(ann.world!.hash());
    // The computer played Bob's team while he was away, and handed it back.
    expect(ann.world!.factions[2].ai).toBeNull();

    ann.conn.close();
    bob2.conn.close();
  }, 20000);

  it('turns away a bad code and a full or started game', async () => {
    const a = await new Bot().open();
    a.conn.send({ t: 'join', code: 'ZZZZ', name: 'x' });
    expect(((await a.wait('error')) as { msg: string }).msg).toMatch(/No game/);
    a.conn.send({ t: 'create', name: 'A' });
    await a.wait('joined');
    a.conn.send({ t: 'start' });
    await a.wait('start');
    const b = await new Bot().open();
    b.conn.send({ t: 'join', code: a.code, name: 'B' });
    expect(((await b.wait('error')) as { msg: string }).msg).toMatch(/already started/);
    a.conn.close();
    b.conn.close();
  });
});
