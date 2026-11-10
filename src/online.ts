import type { Game, OnlineOptions } from './game';
import { MODES, type ModeId } from './modes';
import { Connection, relayUrl } from './net/client';
import { MAX_TEAMS, type GameInfo, type Lobby, type ServerMsg, type Slot } from './net/protocol';
import { platform } from './platform';
import { MAPS, SIZES, type MapId, type MapSize } from './sim/maps';
import { teamDefs } from './sim/world';
import { mapPicker } from './ui/mapPicker';

/** What the online screens need from the rest of the app. */
export interface OnlineHost {
  menu: HTMLElement;
  /** Back to the main menu. */
  back(): void;
  /** Start (or restart) the game for this setup. */
  play(o: OnlineOptions): Promise<Game>;
  /** Close the game and show the menu again. */
  stop(): void;
}

const NAME_KEY = 'mindblobs.name';
const SEAT_KEY = 'mindblobs.seat';

const esc = (s: string): string => s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
const hex = (c: number): string => `#${c.toString(16).padStart(6, '0')}`;

/** On itch the game runs in a frame: its address isn't the page friends should open, so we share the code instead. */
const inFrame = window.self !== window.top;

/** Must run straight from a click. Frames are refused the newer clipboard API, but this older command works in them. */
function copyText(text: string): boolean {
  const box = document.createElement('textarea');
  box.value = text;
  box.readOnly = true;
  box.style.cssText = 'position:fixed;opacity:0;font-size:16px';
  document.body.append(box);
  box.select();
  box.setSelectionRange(0, text.length);
  const copied = document.execCommand('copy');
  box.remove();
  return copied;
}

/** Remembers your place in a game for this tab, so a reload puts you back in it. */
function savedSeat(code: string): string | undefined {
  try {
    const s = JSON.parse(sessionStorage.getItem(SEAT_KEY) ?? 'null') as { code: string; token: string } | null;
    return s && s.code === code ? s.token : undefined;
  } catch {
    return undefined;
  }
}

function saveSeat(code: string, token: string | null): void {
  try {
    if (token) sessionStorage.setItem(SEAT_KEY, JSON.stringify({ code, token }));
    else sessionStorage.removeItem(SEAT_KEY);
  } catch {
    // Storage blocked: reloading just won't rejoin.
  }
  // The address bar carries the code, so a reload (or a copied link) leads back to this game.
  const url = new URL(location.href);
  if (token) url.searchParams.set('room', code);
  else url.searchParams.delete('room');
  history.replaceState(null, '', url);
}

export const onlineAvailable = (): boolean => relayUrl() !== null;

/** The online part of the menu: create or join a game, the lobby, and the running game's messages. */
export class Online {
  private conn: Connection | null = null;
  private lobby: Lobby | null = null;
  private you = 0;
  private token = '';
  private game: Game | null = null;
  /** Messages that arrive while the game is still loading. */
  private early: ServerMsg[] = [];
  private loading = false;
  private error = '';
  private retries = 0;
  /** Reconnecting after losing the server, so a refusal means the game is gone. */
  private rejoining = false;
  private menuTapAt = 0;
  /** A second connection while the home screen is up, just for the list of open games. */
  private browse: Connection | null = null;
  private browseOpening = false;
  /** Bumped whenever browsing stops, so a connection that opens afterwards closes itself. */
  private browseId = 0;
  private browseTries = 0;
  private browseFailed = false;
  /** Open games, or null until the server has sent the list. */
  private games: GameInfo[] | null = null;

  constructor(private readonly host: OnlineHost) {}

  private get isHost(): boolean {
    return !!this.lobby && this.lobby.host === this.you;
  }

  private get name(): string {
    return platform.storage.getItem(NAME_KEY) ?? '';
  }

  /** The first online screen. `code` comes from an invite link. */
  open(code = ''): void {
    if (code && savedSeat(code)) {
      void this.connect({ t: 'join', code, name: this.name, token: savedSeat(code) });
      return;
    }
    this.showHome(code);
  }

  private showHome(code = ''): void {
    const m = this.host.menu;
    m.hidden = false;
    m.innerHTML = `<div class="menu-card online">
      <div class="tuts-h"><button data-back title="Back">←</button><h2>🌐 Play online</h2></div>
      <p class="tag">Make a game and share its code, or join an open one.</p>
      <label class="field"><span>Your name</span><input data-name maxlength="16" placeholder="Player" value="${esc(this.name)}" autocomplete="nickname"></label>
      <button class="big-btn good" data-create>✨ Make a game</button>
      <div class="join-row">
        <input data-code maxlength="4" placeholder="CODE" value="${esc(code)}" autocapitalize="characters" spellcheck="false">
        <button class="big-btn" data-join>Join</button>
      </div>
      <p class="err" ${this.error ? '' : 'hidden'}>${esc(this.error)}</p>
      <div class="open-games"><h3>Open games</h3><div data-games></div></div>
    </div>`;
    this.error = '';
    const nameIn = m.querySelector<HTMLInputElement>('[data-name]')!;
    const codeIn = m.querySelector<HTMLInputElement>('[data-code]')!;
    const name = (): string => {
      const n = nameIn.value.trim().slice(0, 16);
      platform.storage.setItem(NAME_KEY, n);
      return n;
    };
    m.querySelector('[data-back]')!.addEventListener('click', () => {
      this.stopBrowsing();
      this.host.back();
    });
    m.querySelector('[data-games]')!.addEventListener('click', (e) => {
      const game = (e.target as HTMLElement).closest<HTMLElement>('[data-game]')?.dataset.game;
      if (game) void this.connect({ t: 'join', code: game, name: name() });
    });
    m.querySelector('[data-create]')!.addEventListener('click', () => void this.connect({ t: 'create', name: name() }));
    const join = (): void => {
      const c = codeIn.value.trim().toUpperCase();
      if (c.length !== 4) {
        codeIn.focus();
        return;
      }
      void this.connect({ t: 'join', code: c, name: name() });
    };
    m.querySelector('[data-join]')!.addEventListener('click', join);
    codeIn.addEventListener('input', () => (codeIn.value = codeIn.value.toUpperCase().replace(/[^A-Z]/g, '')));
    codeIn.addEventListener('keydown', (e) => e.key === 'Enter' && join());
    (code ? codeIn : nameIn).focus();
    this.renderGames();
    this.startBrowsing();
  }

  // ───────────────────────────── open games ─────────────────────────────

  private onHome(): boolean {
    return !this.host.menu.hidden && !!this.host.menu.querySelector('[data-games]');
  }

  private startBrowsing(): void {
    const url = relayUrl();
    if (!url || this.browse || this.browseOpening || !this.onHome()) return;
    const id = this.browseId;
    this.browseOpening = true;
    Connection.open(url).then(
      (c) => {
        this.browseOpening = false;
        if (id !== this.browseId || !this.onHome()) {
          c.close();
          return;
        }
        this.browse = c;
        this.browseTries = 0;
        this.browseFailed = false;
        c.onMsg = (m) => {
          if (m.t !== 'games') return;
          this.games = m.games;
          this.renderGames();
        };
        c.onClose = () => {
          this.browse = null;
          this.retryBrowsing();
        };
        c.send({ t: 'watch' });
      },
      () => {
        this.browseOpening = false;
        if (id === this.browseId) this.retryBrowsing();
      },
    );
  }

  private retryBrowsing(): void {
    if (!this.onHome()) return;
    if (this.browseTries >= 3) {
      this.browseFailed = true;
      this.renderGames();
      return;
    }
    this.browseTries++;
    setTimeout(() => this.startBrowsing(), 2000 * this.browseTries);
  }

  private stopBrowsing(): void {
    this.browseId++;
    this.browseOpening = false;
    this.browse?.close();
    this.browse = null;
    this.browseTries = 0;
  }

  private renderGames(): void {
    const box = this.host.menu.querySelector<HTMLElement>('[data-games]');
    if (!box) return;
    const games = this.games;
    if (this.browseFailed) box.innerHTML = '<p class="note">Couldn’t reach the game server to list games.</p>';
    else if (!games) box.innerHTML = '<p class="note">Looking for games…</p>';
    else if (!games.length) box.innerHTML = '<p class="note">No open games right now. Make one and it shows up here for everyone.</p>';
    else
      box.innerHTML = games
        .map((g) => {
          const where = [
            `${g.mode === 'pro' ? '🖥️' : '📱'} ${MODES[g.mode]?.label ?? ''}`,
            `${MAPS[g.map]?.icon ?? ''} ${MAPS[g.map]?.label ?? ''}`,
            SIZES[g.size]?.label ?? '',
          ].join(' · ');
          return `<button data-game="${esc(g.code)}" title="Join ${esc(g.host)}’s game">
            <span class="t"><b>${esc(g.host)}’s game</b><span>${esc(where)}</span></span>
            <span class="seats" title="People in it, out of the teams open for people">👤 ${g.players}/${g.players + g.free}</span>
            <span class="go">Join</span></button>`;
        })
        .join('');
  }

  private showBusy(text: string): void {
    this.host.menu.hidden = false;
    this.host.menu.innerHTML = `<div class="menu-card online"><p class="tag">${esc(text)}</p></div>`;
  }

  private async connect(
    first: { t: 'create'; name: string } | { t: 'join'; code: string; name: string; token?: string },
    quiet = false,
  ): Promise<void> {
    const url = relayUrl();
    if (!url) return;
    this.stopBrowsing();
    if (!quiet) this.showBusy('Connecting…');
    try {
      this.conn?.close();
      const conn = await Connection.open(url);
      this.conn = conn;
      conn.onMsg = (msg) => this.onMsg(msg);
      conn.onClose = () => this.lost();
      conn.send(first);
    } catch (e) {
      if (quiet) {
        this.lost();
        return;
      }
      this.error = (e as Error).message;
      this.showHome(first.t === 'join' ? first.code : '');
    }
  }

  /** Lost the server mid-game: try to get back in a few times. */
  private lost(): void {
    this.conn = null;
    const code = this.lobby?.code;
    if (code && this.token && this.retries < 5) {
      this.retries++;
      this.rejoining = true;
      this.game?.say('📡 Connection lost. Reconnecting…');
      setTimeout(() => void this.connect({ t: 'join', code, name: this.name, token: this.token }, !!this.game), 1000 * this.retries);
      return;
    }
    this.error = 'Lost the connection to the game.';
    this.reset();
    this.host.stop();
    this.showHome(code);
  }

  private reset(): void {
    this.lobby = null;
    this.game = null;
    this.early = [];
    this.loading = false;
    this.retries = 0;
    this.rejoining = false;
  }

  /** Leave the game or lobby for good. */
  leave(): void {
    this.conn?.send({ t: 'leave' });
    this.conn?.close();
    this.conn = null;
    if (this.lobby) saveSeat(this.lobby.code, null);
    this.reset();
    this.host.back();
  }

  /** ☰ in a game: leaving an online game takes a second tap, so it can't happen by accident. */
  menuTap(): void {
    const now = performance.now();
    if (!this.game || this.game.ended || now - this.menuTapAt < 3000) {
      this.leave();
      return;
    }
    this.menuTapAt = now;
    this.game.say('Tap ☰ again to leave this online game.');
  }

  /** "Play again" at the end: the host takes everyone back to the lobby. */
  rematch(): void {
    if (this.isHost) this.conn?.send({ t: 'rematch' });
    else this.game?.say('Waiting for the host to start another game.');
  }

  private onMsg(m: ServerMsg): void {
    switch (m.t) {
      case 'joined':
        this.you = m.you;
        this.token = m.token;
        this.retries = 0;
        this.rejoining = false;
        saveSeat(m.lobby.code, m.token);
        this.lobby = m.lobby;
        if (!m.lobby.playing) this.showLobby();
        return;
      case 'lobby': {
        const before = this.lobby;
        this.lobby = m.lobby;
        if (this.game && !m.lobby.playing) {
          // Back to the lobby for another game.
          this.game = null;
          this.host.stop();
          this.showLobby();
        } else if (this.game && before) {
          for (const p of m.lobby.players) {
            const was = before.players.find((q) => q.id === p.id);
            if (was?.connected && !p.connected) this.game.notice(`👋 ${p.name} left. The computer plays their team for now.`);
            if (was && !was.connected && p.connected) this.game.notice(`🙌 ${p.name} is back.`);
          }
        } else if (!this.game && !this.loading) {
          this.showLobby();
        }
        return;
      }
      case 'start': {
        this.loading = true;
        this.early = [];
        this.game = null;
        const send = (msg: Parameters<Connection['send']>[0]): void => this.conn?.send(msg);
        void this.host
          .play({
            setup: m.setup,
            team: m.team,
            speed: m.speed,
            paused: m.paused,
            resume: m.resume,
            send,
            isHost: () => this.isHost,
          })
          .then((g) => {
            this.game = g;
            this.loading = false;
            for (const e of this.early.splice(0)) this.onMsg(e);
            g.notice(m.resume ? '🔄 Back in the game.' : `🌐 Online game ${this.lobby?.code ?? ''}. Good luck!`);
          });
        return;
      }
      case 'turn':
      case 'snap':
      case 'snapReq':
      case 'pace':
        if (this.loading) {
          this.early.push(m);
          return;
        }
        if (m.t === 'turn') this.game?.onTurn(m.turn);
        else if (m.t === 'snap') this.game?.onSnap(m.n, m.data, m.turns);
        else if (m.t === 'snapReq') this.game?.onSnapRequest();
        else this.game?.onPace(m.speed, m.paused);
        return;
      case 'error':
        if (this.rejoining) {
          if (this.lobby) saveSeat(this.lobby.code, null);
          this.conn?.close();
          this.conn = null;
          this.reset();
          this.host.stop();
          this.error = 'That game is gone: the game server restarted or closed it.';
          this.showHome();
        } else if (this.game) {
          this.game.say(m.msg);
        } else if (this.lobby) {
          this.error = m.msg;
          this.showLobby();
        } else {
          this.error = m.msg;
          this.conn?.close();
          this.conn = null;
          this.showHome();
        }
        return;
    }
  }

  // ───────────────────────────── lobby ─────────────────────────────

  private settings(change: { mode?: ModeId; map?: MapId; size?: MapSize; slots?: Slot['kind'][]; listed?: boolean }): void {
    this.conn?.send({ t: 'settings', ...change });
  }

  private showLobby(): void {
    const l = this.lobby;
    if (!l) return;
    const m = this.host.menu;
    m.hidden = false;
    const host = this.isHost;
    const defs = teamDefs(l.slots.length - 1);
    const playerName = (id: number | null): string => l.players.find((p) => p.id === id)?.name ?? '';
    const mySlot = l.slots.findIndex((s) => s.player === this.you);
    const kinds = l.slots.map((s) => s.kind);
    const rows = l.slots
      .map((s, i) => {
        const d = defs[i + 1];
        const who =
          s.kind === 'ai'
            ? '🤖 Computer'
            : s.player !== null
              ? `${esc(playerName(s.player))}${s.player === l.host ? ' <small>host</small>' : ''}${s.player === this.you ? ' <small>you</small>' : ''}`
              : '<i>Open, waiting for a player</i>';
        const sit = s.kind === 'open' && s.player === null ? `<button data-sit="${i}">Sit here</button>` : '';
        const kind =
          host && (s.player === null || s.kind === 'ai')
            ? `<button data-kind="${i}" title="Switch between a person and the computer">${s.kind === 'ai' ? '👤 Make open' : '🤖 Computer'}</button>`
            : '';
        const drop = host && l.slots.length > 2 && i === l.slots.length - 1 && s.player !== this.you ? `<button data-drop title="Remove this team">✕</button>` : '';
        return `<li class="${i === mySlot ? 'mine' : ''}"><span class="dot" style="background:${hex(d.color)}"></span>
          <span class="t"><b>${esc(d.name)}</b><span>${who}</span></span>${sit}${kind}${drop}</li>`;
      })
      .join('');
    const share = inFrame ? l.code : `${location.origin}${location.pathname}?room=${l.code}`;
    const listed = l.listed !== false;
    const vis = (on: boolean): string =>
      `<button data-listed="${on ? 1 : 0}" class="${listed === on ? 'on' : ''}" ${host ? '' : 'disabled'}>${on ? '🌍 Public' : '🔒 Private'}</button>`;
    const mode = (id: ModeId): string =>
      `<button data-mode="${id}" class="${l.mode === id ? 'on' : ''}" ${host ? '' : 'disabled'}>${id === 'casual' ? '📱' : '🖥️'} ${MODES[id].label}</button>`;
    m.innerHTML = `<div class="menu-card online lobby">
      <div class="tuts-h"><button data-leave title="Leave">←</button><h2>🌐 Online game</h2></div>
      <div class="code-row"><span>Code</span><b class="code">${l.code}</b><button data-copy>📋 Copy ${inFrame ? 'code' : 'invite link'}</button></div>
      <div class="seg mode-seg">${vis(true)}${vis(false)}</div>
      <p class="note vis-note">${listed ? 'Anyone can see this game in the open games list and join it.' : 'Hidden from the list: only people with the code can join.'}</p>
      <div class="seg mode-seg">${mode('casual')}${mode('pro')}</div>
      ${l.mode === 'pro' ? '<p class="note">Pro needs a keyboard and mouse. Pick Casual if anyone is on a phone.</p>' : ''}
      ${mapPicker(l.map ?? 'meadow', l.size ?? 'medium', host)}
      <ol class="slots">${rows}</ol>
      ${host && l.slots.length < MAX_TEAMS ? '<button data-add class="add">＋ Add a team</button>' : ''}
      <p class="err" ${this.error ? '' : 'hidden'}>${esc(this.error)}</p>
      ${
        host
          ? '<button class="big-btn good" data-start>▶ Start game</button>'
          : '<p class="tag">Waiting for the host to start…</p>'
      }
    </div>`;
    this.error = '';
    m.querySelector('[data-leave]')!.addEventListener('click', () => this.leave());
    m.querySelector('[data-copy]')!.addEventListener('click', (e) => {
      const btn = e.currentTarget as HTMLButtonElement;
      if (copyText(share)) btn.textContent = '✅ Copied';
      else if (inFrame) btn.textContent = 'Tell friends the code';
      else window.prompt('Send this link to your friends:', share);
    });
    m.querySelectorAll<HTMLButtonElement>('[data-listed]').forEach((b) =>
      b.addEventListener('click', () => this.settings({ listed: b.dataset.listed === '1' })),
    );
    m.querySelectorAll<HTMLButtonElement>('[data-mode]').forEach((b) =>
      b.addEventListener('click', () => this.settings({ mode: b.dataset.mode as ModeId })),
    );
    m.querySelectorAll<HTMLButtonElement>('[data-map]').forEach((b) =>
      b.addEventListener('click', () => this.settings({ map: b.dataset.map as MapId })),
    );
    m.querySelectorAll<HTMLButtonElement>('[data-size]').forEach((b) =>
      b.addEventListener('click', () => this.settings({ size: b.dataset.size as MapSize })),
    );
    m.querySelectorAll<HTMLButtonElement>('[data-sit]').forEach((b) =>
      b.addEventListener('click', () => this.conn?.send({ t: 'sit', slot: Number(b.dataset.sit) })),
    );
    m.querySelectorAll<HTMLButtonElement>('[data-kind]').forEach((b) =>
      b.addEventListener('click', () => {
        const i = Number(b.dataset.kind);
        this.settings({ slots: kinds.map((k, j) => (j === i ? (k === 'ai' ? 'open' : 'ai') : k)) });
      }),
    );
    m.querySelector('[data-drop]')?.addEventListener('click', () => this.settings({ slots: kinds.slice(0, -1) }));
    m.querySelector('[data-add]')?.addEventListener('click', () => this.settings({ slots: [...kinds, 'ai'] }));
    m.querySelector('[data-start]')?.addEventListener('click', () => this.conn?.send({ t: 'start' }));
  }
}
