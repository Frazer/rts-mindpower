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
  describe('list of open games', () => {
    it('shows public games with room, and updates as they change', () => {
      const relay = createRelay();
      const eve = new Person(relay);
      eve.say({ t: 'watch' });
      expect(eve.last('games').games).toEqual([]);

      const ann = new Person(relay);
      ann.say({ t: 'create', name: 'Ann' });
      const code = ann.last('joined').lobby.code;
      vi.advanceTimersByTime(500);
      expect(eve.last('games').games).toEqual([
        { code, host: 'Ann', mode: 'casual', map: 'meadow', size: 'medium', players: 1, free: 1, teams: 3 },
      ]);

      // Full: nobody else can sit down.
      const bob = new Person(relay);
      bob.say({ t: 'join', code, name: 'Bob' });
      vi.advanceTimersByTime(500);
      expect(eve.last('games').games).toEqual([]);

      // A free team again, then the game starts.
      ann.say({ t: 'settings', slots: ['open', 'open', 'open'] });
      vi.advanceTimersByTime(500);
      expect(eve.last('games').games.map((g) => g.free)).toEqual([1]);
      ann.say({ t: 'start' });
      vi.advanceTimersByTime(500);
      expect(eve.last('games').games).toEqual([]);
    });

    it('leaves out private games', () => {
      const relay = createRelay();
      const eve = new Person(relay);
      eve.say({ t: 'watch' });
      const ann = new Person(relay);
      ann.say({ t: 'create', name: 'Ann' });
      ann.say({ t: 'settings', listed: false });
      vi.advanceTimersByTime(500);
      expect(ann.last('lobby').lobby.listed).toBe(false);
      expect(eve.last('games').games).toEqual([]);
      ann.say({ t: 'settings', listed: true });
      vi.advanceTimersByTime(500);
      expect(eve.last('games').games).toHaveLength(1);
    });

    it('stops sending the list once you join a game', () => {
      const relay = createRelay();
      const ann = new Person(relay);
      ann.say({ t: 'create', name: 'Ann' });
      const eve = new Person(relay);
      eve.say({ t: 'watch' });
      eve.say({ t: 'join', code: ann.last('joined').lobby.code, name: 'Eve' });
      const seen = eve.sock.sent.length;
      const cat = new Person(relay);
      cat.say({ t: 'create', name: 'Cat' });
      vi.advanceTimersByTime(500);
      expect(eve.sock.sent.slice(seen).some((m) => m.t === 'games')).toBe(false);
    });

    it('sends the list again when it changes back after nobody was watching', () => {
      const relay = createRelay();
      const eve = new Person(relay);
      eve.say({ t: 'watch' });
      const ann = new Person(relay);
      ann.say({ t: 'create', name: 'Ann' });
      vi.advanceTimersByTime(500);
      ann.say({ t: 'leave' });
      vi.advanceTimersByTime(500);
      expect(eve.last('games').games).toEqual([]);
      relay.closed(eve.s);
      // Nobody watching while Bob makes a game; Fay sees it, then sees it go.
      const bob = new Person(relay);
      bob.say({ t: 'create', name: 'Bob' });
      const fay = new Person(relay);
      fay.say({ t: 'watch' });
      expect(fay.last('games').games).toHaveLength(1);
      bob.say({ t: 'leave' });
      vi.advanceTimersByTime(500);
      expect(fay.last('games').games).toEqual([]);
    });
  });
});
