import type { ModeId } from '../modes';
import type { MapId, MapSize } from '../sim/maps';
import type { Command } from '../sim/types';

/** Real seconds per turn. The server sends one turn this often, each worth a few game ticks. */
export const TURN_SEC = 0.1;
/** Players send a fingerprint of their game every this many turns. */
export const HASH_EVERY = 20;
/** Most teams in one game (you plus six rivals). */
export const MAX_TEAMS = 7;
/** Players say they're still here this often, even with nothing else to send. */
export const ALIVE_SEC = 15;
/** A connection that sends nothing for this long is dropped. Long enough for a hidden tab, whose timers run about once a minute. */
export const SILENT_SEC = 75;

/** A team in the lobby: open for a person, or played by the computer. */
export interface Slot {
  kind: 'open' | 'ai';
  /** Seated player's id. */
  player: number | null;
}

export interface LobbyPlayer {
  id: number;
  name: string;
  connected: boolean;
}

export interface Lobby {
  code: string;
  host: number;
  mode: ModeId;
  map: MapId;
  size: MapSize;
  /** Slot i is team i + 1. */
  slots: Slot[];
  players: LobbyPlayer[];
  playing: boolean;
  /** Shown in everyone's list of open games, not just reachable by its code. */
  listed: boolean;
}

/** A public game waiting for players, as the list of open games shows it. */
export interface GameInfo {
  code: string;
  /** Host's name. */
  host: string;
  mode: ModeId;
  map: MapId;
  size: MapSize;
  /** People in it now. */
  players: number;
  /** Teams still open for a person. */
  free: number;
  teams: number;
}

/** What every player needs to build the same world. */
export interface Setup {
  seed: number;
  mode: ModeId;
  rivals: number;
  map: MapId;
  size: MapSize;
  /** Teams played by people, and their names. */
  humans: number[];
  names: Record<number, string>;
}

export interface Turn {
  n: number;
  /** Game ticks in this turn (more when the game runs faster). */
  k: number;
  c: Command[];
}

export type ClientMsg =
  | { t: 'create'; name: string }
  | { t: 'join'; code: string; name: string; token?: string }
  | { t: 'settings'; mode?: ModeId; map?: MapId; size?: MapSize; slots?: Slot['kind'][]; listed?: boolean }
  /** Send me the list of open public games, and again whenever it changes. */
  | { t: 'watch' }
  | { t: 'sit'; slot: number }
  | { t: 'start' }
  | { t: 'cmd'; c: Command }
  | { t: 'hash'; n: number; h: number }
  | { t: 'snap'; n: number; data: string }
  | { t: 'pace'; speed?: number; paused?: boolean }
  | { t: 'rematch' }
  | { t: 'leave' }
  | { t: 'alive' };

export type ServerMsg =
  | { t: 'joined'; you: number; token: string; lobby: Lobby }
  | { t: 'lobby'; lobby: Lobby }
  | { t: 'start'; setup: Setup; you: number; team: number; speed: number; paused: boolean; resume: boolean }
  | { t: 'turn'; turn: Turn }
  | { t: 'pace'; speed: number; paused: boolean }
  /** Host only: send a snapshot after your next finished turn. */
  | { t: 'snapReq' }
  /** You fell out of step (or rejoined): load this, then play these turns. */
  | { t: 'snap'; n: number; data: string; turns: Turn[] }
  /** Open public games, newest first. */
  | { t: 'games'; games: GameInfo[] }
  | { t: 'error'; msg: string };
