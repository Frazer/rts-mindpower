import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRelay, type Relay, type Session, type Sock } from '../server/rooms';
import { ALIVE_SEC, type ClientMsg, type ServerMsg } from '../src/net/protocol';

class FakeSock implements Sock {
  sent: ServerMsg[] = [];
  closed = false;
  send(text: string): void {
    if (!this.closed) this.sent.push(JSON.parse(text) as ServerMsg);
  }
  close(): void {
    this.closed = true;
  }
}

class Person {
  sock = new FakeSock();
  s: Session;
  constructor(private readonly relay: Relay) {
    this.s = relay.open(this.sock);
  }
  say(m: ClientMsg): void {
    this.relay.message(this.s, JSON.stringify(m));
  }
  last<T extends ServerMsg['t']>(t: T): Extract<ServerMsg, { t: T }> {
    return this.sock.sent.filter((m) => m.t === t).at(-1) as Extract<ServerMsg, { t: T }>;
  }
}

/** A game with two people in it. */
function twoPlaying(relay: Relay): { ann: Person; bob: Person; code: string } {
  const ann = new Person(relay);
  ann.say({ t: 'create', name: 'Ann' });
  const code = ann.last('joined').lobby.code;
  const bob = new Person(relay);
  bob.say({ t: 'join', code, name: 'Bob' });
  ann.say({ t: 'start' });
  return { ann, bob, code };
}

/** Time passes with only these people still saying they're here. */
function passTime(sec: number, ...talking: Person[]): void {
  for (let t = 0; t < sec; t += ALIVE_SEC) {
    for (const p of talking) p.say({ t: 'alive' });
    vi.advanceTimersByTime(ALIVE_SEC * 1000);
  }
}

describe('relay rooms', () => {
  beforeEach(() => void vi.useFakeTimers());
  afterEach(() => void vi.useRealTimers());

  it('leaves a quiet lobby alone while players say they are still there', () => {
    const relay = createRelay();
    const ann = new Person(relay);
    ann.say({ t: 'create', name: 'Ann' });
    passTime(600, ann);
    expect(ann.sock.closed).toBe(false);
  });

  it('drops a connection that goes silent, and the computer takes over its team', () => {
    const relay = createRelay();
    const { ann, bob } = twoPlaying(relay);
    passTime(60, ann, bob);
    expect(bob.sock.closed).toBe(false);
    passTime(90, ann);
    expect(bob.sock.closed).toBe(true);
    expect(ann.sock.closed).toBe(false);
    expect(ann.last('lobby').lobby.players.map((p) => p.connected)).toEqual([true, false]);
    const orders = ann.sock.sent.flatMap((m) => (m.t === 'turn' ? m.turn.c : []));
    expect(orders).toContainEqual({ type: 'setAi', faction: 2, on: true });
  });

  it('ignores the old connection closing after a player has rejoined on a new one', () => {
    const relay = createRelay();
    const { ann, bob, code } = twoPlaying(relay);
    const token = bob.last('joined').token;
    const again = new Person(relay);
    again.say({ t: 'join', code, name: 'Bob', token });
    expect(bob.sock.closed).toBe(true);
    relay.closed(bob.s);
    expect(ann.last('lobby').lobby.players.map((p) => p.connected)).toEqual([true, true]);
    expect(again.last('start').resume).toBe(true);
  });

  it('stops every timer once everyone has gone, so an idle server can sleep', () => {
    const relay = createRelay();
    const lobby = new Person(relay);
    lobby.say({ t: 'create', name: 'A' });
    expect(vi.getTimerCount()).toBe(1);
    relay.closed(lobby.s);
    expect(vi.getTimerCount()).toBe(0);

    const { ann, bob, code } = twoPlaying(relay);
    expect(vi.getTimerCount()).toBe(2);
    relay.closed(ann.s);
    relay.closed(bob.s);
    // A game keeps going for a while, in case someone reloads.
    vi.advanceTimersByTime(100_000);
    expect(vi.getTimerCount()).toBe(2);
    vi.advanceTimersByTime(40_000);
    expect(vi.getTimerCount()).toBe(0);
    const late = new Person(relay);
    late.say({ t: 'join', code, name: 'Late' });
    expect(late.last('error').msg).toMatch(/No game/);
  });

  it('closes a game that has run for three hours', () => {
    const relay = createRelay();
    const { ann, bob, code } = twoPlaying(relay);
    passTime(2.9 * 3600, ann, bob);
    expect(ann.sock.closed).toBe(false);
    passTime(0.2 * 3600, ann, bob);
    expect(ann.sock.closed).toBe(true);
    expect(bob.sock.closed).toBe(true);
    const late = new Person(relay);
    late.say({ t: 'join', code, name: 'Late', token: bob.last('joined').token });
    expect(late.last('error').msg).toMatch(/No game/);
  });
});
