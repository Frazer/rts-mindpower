/**
 * Online relay for Mind Blobs. Every player runs the whole game; this server only
 * gathers everyone's orders and sends them out as numbered turns, one every TURN_SEC.
 * Nobody waits for anybody: a slow or hidden tab falls behind and catches up.
 *
 * It also referees drift: players send a fingerprint of their game now and then, and
 * anyone whose fingerprint differs from the host's gets a copy of the host's game.
 *
 * This file doesn't care what the connections run on: relay.ts plugs it into Node
 * (`npm run dev`, `npm run relay`) and worker.ts into Cloudflare.
 */
import { MODES, type ModeId } from '../src/modes.ts';
import { MAX_TEAMS, SILENT_SEC, TURN_SEC, type ClientMsg, type GameInfo, type Lobby, type ServerMsg, type Slot, type Turn } from '../src/net/protocol.ts';
import { DT } from '../src/sim/config.ts';
import { isMapId, isMapSize, type MapId, type MapSize } from '../src/sim/maps.ts';
import type { Command } from '../src/sim/types.ts';

/** One connection, whatever it runs on. Sending on a closed one must do nothing. */
export interface Sock {
  send(text: string): void;
  close(): void;
}

interface Player {
  id: number;
  name: string;
  token: string;
  sock: Sock | null;
  room: Room | null;
}

/** An open connection and whose it is (rejoining moves it to the player's old place). */
export interface Session {
  sock: Sock;
  player: Player;
  /** When it last sent anything. */
  seen: number;
}

export interface Relay {
  open(sock: Sock): Session;
  message(s: Session, text: string): void;
  closed(s: Session): void;
}

/** Biggest message a player may send (a copy of the game is the big one). */
export const MAX_MESSAGE = 16 * 1024 * 1024;
const EMPTY_MS = 120_000;
/** Every turn stays in memory for rejoins, and all rooms share one server, so a game can't run for ever. */
const MAX_TURNS = (3 * 60 * 60) / TURN_SEC;
/** Most games the list of open games shows. */
const MAX_LISTED = 20;
/** Messages that can change which games are open, or how they look in the list. */
const LIST_CHANGES = new Set<ClientMsg['t']>(['create', 'join', 'settings', 'sit', 'start', 'rematch', 'leave']);

interface Match {
  seed: number;
  turn: number;
  speed: number;
  paused: boolean;
  pending: Command[];
  log: Turn[];
  timer: ReturnType<typeof setInterval>;
  /** Host's fingerprint by turn, and other players' waiting for the host's. */
  hostHash: Map<number, number>;
  early: Map<number, { player: number; h: number }[]>;
  /** Players who need a copy of the host's game. */
  needSnap: Set<number>;
  askedAt: number;
}

interface Room {
  code: string;
  host: number;
  mode: ModeId;
  map: MapId;
  size: MapSize;
  slots: Slot[];
  players: Player[];
  match: Match | null;
  emptySince: number;
  /** In the list of open games. */
  listed: boolean;
}

const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ';

const randomBelow = (n: number): number => crypto.getRandomValues(new Uint32Array(1))[0] % n;
const randomToken = (): string =>
  Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => b.toString(16).padStart(2, '0')).join('');

const send = (p: Player, m: ServerMsg): void => p.sock?.send(JSON.stringify(m));

const connected = (r: Room): Player[] => r.players.filter((p) => p.sock);

function lobbyOf(r: Room): Lobby {
  return {
    code: r.code,
    host: r.host,
    mode: r.mode,
    map: r.map,
    size: r.size,
    slots: r.slots.map((s) => ({ ...s })),
    players: r.players.map((p) => ({ id: p.id, name: p.name, connected: !!p.sock })),
    playing: !!r.match,
    listed: r.listed,
  };
}

/** Public games someone could join right now, newest first. */
function openGames(rooms: Map<string, Room>): GameInfo[] {
  const out: GameInfo[] = [];
  for (const r of [...rooms.values()].reverse()) {
    if (!r.listed || r.match || r.players.length >= MAX_TEAMS) continue;
    const host = r.players.find((p) => p.id === r.host);
    const free = r.slots.filter((s) => s.kind === 'open' && s.player === null).length;
    if (!host?.sock || free === 0) continue;
    out.push({ code: r.code, host: host.name, mode: r.mode, map: r.map, size: r.size, players: connected(r).length, free, teams: r.slots.length });
    if (out.length >= MAX_LISTED) break;
  }
  return out;
}

function broadcastLobby(r: Room): void {
  const lobby = lobbyOf(r);
  for (const p of r.players) send(p, { t: 'lobby', lobby });
}

const cleanName = (s: unknown): string =>
  (typeof s === 'string' ? s : '').replace(/[<>&"]/g, '').replace(/\s+/g, ' ').trim().slice(0, 16) || 'Player';

function newCode(taken: Map<string, Room>): string {
  for (;;) {
    let c = '';
    for (let i = 0; i < 4; i++) c += CODE_CHARS[randomBelow(CODE_CHARS.length)];
    if (!taken.has(c)) return c;
  }
}

const slotOf = (r: Room, id: number): number => r.slots.findIndex((s) => s.player === id);

function unseat(r: Room, id: number): void {
  for (const s of r.slots) if (s.player === id) s.player = null;
}

/** Put a player in the first empty open slot, if there is one. */
function seat(r: Room, id: number): void {
  const s = r.slots.find((x) => x.kind === 'open' && x.player === null);
  if (s) s.player = id;
}

function pickHost(r: Room): void {
  const cur = r.players.find((p) => p.id === r.host);
  if (cur?.sock) return;
  const next = connected(r)[0];
  if (next) r.host = next.id;
}

// ───────────────────────────── a running game ─────────────────────────────

const ticksPerTurn = (speed: number): number => Math.max(1, Math.round((speed * TURN_SEC) / DT));

function startMatch(r: Room): void {
  const humans: number[] = [];
  const names: Record<number, string> = {};
  r.slots.forEach((s, i) => {
    const p = s.player !== null ? r.players.find((x) => x.id === s.player) : undefined;
    if (p) {
      humans.push(i + 1);
      names[i + 1] = p.name;
    }
  });
  const speed = MODES[r.mode].defaultSpeed;
  const m: Match = {
    seed: 1 + randomBelow(2 ** 31 - 1),
    turn: 0,
    speed,
    paused: false,
    pending: [],
    log: [],
    timer: setInterval(() => nextTurn(r), TURN_SEC * 1000),
    hostHash: new Map(),
    early: new Map(),
    needSnap: new Set(),
    askedAt: 0,
  };
  r.match = m;
  const setup = { seed: m.seed, mode: r.mode, rivals: r.slots.length - 1, map: r.map, size: r.size, humans, names };
  for (const p of r.players) {
    const team = slotOf(r, p.id) + 1;
    send(p, { t: 'start', setup, you: p.id, team, speed, paused: false, resume: false });
  }
  broadcastLobby(r);
}

function stopMatch(r: Room): void {
  if (r.match) clearInterval(r.match.timer);
  r.match = null;
}

function nextTurn(r: Room): void {
  const m = r.match;
  if (!m || m.paused) return;
  m.turn++;
  const turn: Turn = { n: m.turn, k: ticksPerTurn(m.speed), c: m.pending };
  m.pending = [];
  m.log.push(turn);
  const msg = JSON.stringify({ t: 'turn', turn } satisfies ServerMsg);
  for (const p of r.players) p.sock?.send(msg);
  for (const n of m.hostHash.keys()) if (n < m.turn - 600) m.hostHash.delete(n);
  for (const n of m.early.keys()) if (n < m.turn - 600) m.early.delete(n);
  askSnap(r);
}

/** The computer runs a team while its player is away. */
function setAi(r: Room, id: number, on: boolean): void {
  const team = slotOf(r, id) + 1;
  if (r.match && team > 0) r.match.pending.push({ type: 'setAi', faction: team, on });
}

function askSnap(r: Room): void {
  const m = r.match;
  if (!m || m.needSnap.size === 0) return;
  const host = r.players.find((p) => p.id === r.host);
  if (!host?.sock || Date.now() - m.askedAt < 3000) return;
  m.askedAt = Date.now();
  send(host, { t: 'snapReq' });
}

function checkHash(r: Room, player: number, n: number, h: number): void {
  const m = r.match!;
  if (player === r.host) {
    m.hostHash.set(n, h);
    for (const e of m.early.get(n) ?? []) if (e.h !== h) m.needSnap.add(e.player);
    m.early.delete(n);
  } else {
    const want = m.hostHash.get(n);
    if (want === undefined) {
      const list = m.early.get(n) ?? [];
      list.push({ player, h });
      m.early.set(n, list);
    } else if (want !== h) {
      m.needSnap.add(player);
    }
  }
  askSnap(r);
}

// ───────────────────────────── messages ─────────────────────────────

/** All the rooms one server holds. */
export function createRelay(): Relay {
  const rooms = new Map<string, Room>();
  const sessions = new Set<Session>();
  /** People looking at the list of open games. */
  const watchers = new Set<Session>();
  let lastList = '';
  let listTimer: ReturnType<typeof setTimeout> | undefined;
  let nextPlayer = 1;
  let sweeper: ReturnType<typeof setInterval> | undefined;

  /** Tell everyone looking at the list about changes, a moment later so a burst of them goes as one. */
  function listChanged(): void {
    if (watchers.size === 0 || listTimer !== undefined) return;
    listTimer = setTimeout(() => {
      listTimer = undefined;
      const text = JSON.stringify({ t: 'games', games: openGames(rooms) } satisfies ServerMsg);
      if (text === lastList) return;
      lastList = text;
      for (const s of watchers) s.sock.send(text);
    }, 300);
  }

  function unwatch(s: Session): void {
    watchers.delete(s);
    // Whatever was sent last went to nobody still here: a newcomer's list comes from 'watch'.
    if (watchers.size === 0) lastList = '';
  }

  function onMessage(s: Session, m: ClientMsg): void {
    const p = s.player;
    const r = p.room;
    switch (m.t) {
      case 'watch':
        if (r) return;
        watchers.add(s);
        s.sock.send(JSON.stringify({ t: 'games', games: openGames(rooms) } satisfies ServerMsg));
        return;
      case 'create': {
        if (r) return;
        unwatch(s);
        p.name = cleanName(m.name);
        const room: Room = {
          code: newCode(rooms),
          host: p.id,
          mode: 'casual',
          map: 'meadow',
          size: 'medium',
          slots: [
            { kind: 'open', player: p.id },
            { kind: 'open', player: null },
            { kind: 'ai', player: null },
          ],
          players: [p],
          match: null,
          emptySince: 0,
          listed: true,
        };
        rooms.set(room.code, room);
        p.room = room;
        send(p, { t: 'joined', you: p.id, token: p.token, lobby: lobbyOf(room) });
        return;
      }
      case 'join': {
        if (r) return;
        unwatch(s);
        const room = rooms.get(String(m.code ?? '').toUpperCase().trim());
        if (!room) return send(p, { t: 'error', msg: 'No game with that code.' });
        const back = m.token ? room.players.find((x) => x.token === m.token) : undefined;
        if (back) {
          // Same person again (page reload, lost connection): take over their old place.
          back.sock?.close();
          back.sock = s.sock;
          p.sock = null;
          s.player = back;
          back.room = room;
          pickHost(room);
          send(back, { t: 'joined', you: back.id, token: back.token, lobby: lobbyOf(room) });
          const match = room.match;
          if (match) {
            const team = slotOf(room, back.id) + 1;
            const setup = {
              seed: match.seed,
              mode: room.mode,
              rivals: room.slots.length - 1,
              map: room.map,
              size: room.size,
              humans: room.slots.flatMap((s, i) => (s.player !== null ? [i + 1] : [])),
              names: Object.fromEntries(
                room.slots.flatMap((s, i) => {
                  const q = room.players.find((x) => x.id === s.player);
                  return q ? [[i + 1, q.name]] : [];
                }),
              ),
            };
            send(back, { t: 'start', setup, you: back.id, team, speed: match.speed, paused: match.paused, resume: true });
            setAi(room, back.id, false);
            if (room.host === back.id && connected(room).length === 1) {
              // Nobody else has the game: start it over from the log.
              send(back, { t: 'snap', n: 0, data: '', turns: match.log });
            } else {
              match.needSnap.add(back.id);
              askSnap(room);
            }
          }
          broadcastLobby(room);
          return;
        }
        if (room.match) return send(p, { t: 'error', msg: 'That game has already started.' });
        if (room.players.length >= MAX_TEAMS) return send(p, { t: 'error', msg: 'That game is full.' });
        p.name = cleanName(m.name);
        p.room = room;
        room.players.push(p);
        seat(room, p.id);
        send(p, { t: 'joined', you: p.id, token: p.token, lobby: lobbyOf(room) });
        broadcastLobby(room);
        return;
      }
      case 'settings': {
        if (!r || r.match || r.host !== p.id) return;
        if (m.mode === 'casual' || m.mode === 'pro') r.mode = m.mode;
        if (isMapId(m.map)) r.map = m.map;
        if (isMapSize(m.size)) r.size = m.size;
        if (typeof m.listed === 'boolean') r.listed = m.listed;
        if (Array.isArray(m.slots)) {
          const kinds = m.slots.slice(0, MAX_TEAMS).map((k) => (k === 'ai' ? 'ai' : 'open') as Slot['kind']);
          if (kinds.length >= 2) {
            const old = r.slots;
            r.slots = kinds.map((kind, i) => ({ kind, player: kind === 'open' ? (old[i]?.player ?? null) : null }));
            // Anyone who lost their seat takes a free one if there is one.
            for (const q of r.players) if (slotOf(r, q.id) < 0) seat(r, q.id);
          }
        }
        broadcastLobby(r);
        return;
      }
      case 'sit': {
        if (!r || r.match) return;
        const s = r.slots[m.slot];
        if (!s || s.kind !== 'open' || s.player !== null) return;
        unseat(r, p.id);
        s.player = p.id;
        broadcastLobby(r);
        return;
      }
      case 'start': {
        if (!r || r.match || r.host !== p.id) return;
        if (connected(r).some((q) => slotOf(r, q.id) < 0)) return send(p, { t: 'error', msg: 'Everyone needs a team first.' });
        startMatch(r);
        return;
      }
      case 'cmd': {
        const team = r ? slotOf(r, p.id) + 1 : 0;
        const c = m.c;
        if (!r?.match || team <= 0 || !c || typeof c !== 'object' || typeof c.type !== 'string') return;
        if (c.type === 'gift' || c.type === 'setAi') return;
        if (JSON.stringify(c).length > 20000) return;
        r.match.pending.push({ ...c, faction: team });
        return;
      }
      case 'hash':
        if (r?.match && typeof m.n === 'number' && typeof m.h === 'number') checkHash(r, p.id, m.n, m.h);
        return;
      case 'snap': {
        const match = r?.match;
        if (!r || !match || r.host !== p.id || typeof m.data !== 'string') return;
        const turns = match.log.filter((t) => t.n > m.n);
        for (const id of match.needSnap) {
          const q = r.players.find((x) => x.id === id);
          if (q) send(q, { t: 'snap', n: m.n, data: m.data, turns });
        }
        match.needSnap.clear();
        return;
      }
      case 'pace': {
        const match = r?.match;
        if (!r || !match || r.host !== p.id) return;
        if (typeof m.speed === 'number' && MODES[r.mode].speeds.includes(m.speed)) match.speed = m.speed;
        if (typeof m.paused === 'boolean') match.paused = m.paused;
        for (const q of r.players) send(q, { t: 'pace', speed: match.speed, paused: match.paused });
        return;
      }
      case 'rematch':
        if (!r || !r.match || r.host !== p.id) return;
        stopMatch(r);
        // Back to the lobby: people who left are gone now.
        r.players = r.players.filter((q) => q.sock);
        for (const s of r.slots) if (s.player !== null && !r.players.some((q) => q.id === s.player)) s.player = null;
        broadcastLobby(r);
        return;
      case 'leave':
        if (r) leave(r, p);
        return;
      case 'alive':
        return;
    }
  }

  /** Gone for good: the computer takes over their team. */
  function leave(r: Room, p: Player): void {
    if (r.match) {
      // Keep their seat (the team keeps their name), but they can't come back to it.
      setAi(r, p.id, true);
      p.token = '';
      p.sock = null;
    } else {
      unseat(r, p.id);
      r.players = r.players.filter((x) => x !== p);
    }
    p.room = null;
    pickHost(r);
    closeIfEmpty(r);
    broadcastLobby(r);
  }

  function closeIfEmpty(r: Room): void {
    if (connected(r).length > 0) return;
    if (!r.match) {
      rooms.delete(r.code);
      return;
    }
    r.emptySince ||= Date.now();
  }

  /** Run the sweep only while there's something to sweep: a timer keeps a Cloudflare server awake, and awake is what counts against the free limit. */
  function keepSweeping(): void {
    const needed = rooms.size > 0 || sessions.size > 0;
    if (needed && sweeper === undefined) {
      sweeper = setInterval(sweep, 10_000);
      // Node only: don't let this timer alone keep the process running. Cloudflare's timers are plain numbers.
      Object(sweeper).unref?.();
    } else if (!needed && sweeper !== undefined) {
      clearInterval(sweeper);
      sweeper = undefined;
    }
  }

  function sweep(): void {
    const now = Date.now();
    // Drop connections that stopped talking.
    for (const s of sessions) {
      if (now - s.seen > SILENT_SEC * 1000) {
        s.sock.close();
        closed(s);
      }
    }
    // Rooms nobody has been in for two minutes are gone, and so are games that have run too long.
    for (const r of rooms.values()) {
      if (connected(r).length > 0) r.emptySince = 0;
      const abandoned = r.emptySince > 0 && now - r.emptySince > EMPTY_MS;
      if (abandoned || (r.match && r.match.turn > MAX_TURNS)) {
        stopMatch(r);
        rooms.delete(r.code);
        for (const p of r.players) p.sock?.close();
      }
    }
    listChanged();
    keepSweeping();
  }

  function closed(s: Session): void {
    unwatch(s);
    if (!sessions.delete(s)) return;
    const p = s.player;
    if (p.sock === s.sock) {
      p.sock = null;
      const r = p.room;
      if (r?.match) {
        // Might come back (reload, bad signal): keep their place, the computer stands in.
        setAi(r, p.id, true);
        pickHost(r);
        closeIfEmpty(r);
        broadcastLobby(r);
      } else if (r) {
        leave(r, p);
      }
      listChanged();
    }
    keepSweeping();
  }

  return {
    open(sock) {
      const player: Player = { id: nextPlayer++, name: 'Player', token: randomToken(), sock, room: null };
      const s: Session = { sock, player, seen: Date.now() };
      sessions.add(s);
      keepSweeping();
      return s;
    },
    message(s, text) {
      s.seen = Date.now();
      if (text.length > MAX_MESSAGE) return;
      let m: ClientMsg;
      try {
        m = JSON.parse(text) as ClientMsg;
      } catch {
        return;
      }
      if (!m || typeof m !== 'object' || typeof m.t !== 'string') return;
      onMessage(s, m);
      if (LIST_CHANGES.has(m.t)) listChanged();
    },
    closed,
  };
}
