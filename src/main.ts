import '@fontsource-variable/fredoka/wght.css';
import './style.css';
import { sound } from './audio';
import { Game, type OnlineOptions } from './game';
import { MODES, type ModeId } from './modes';
import { platform } from './platform';
import { completed, markCompleted, resetProgress } from './progress';
import { findLevel, levelsFor } from './tutorials';
import { DEFAULT_RIVALS, MAX_RIVALS, clampRivals, teamDefs } from './sim/world';
import { isMapId, isMapSize, type MapId, type MapSize } from './sim/maps';
import { mapPicker } from './ui/mapPicker';
import { Online, onlineAvailable } from './online';

const host = document.getElementById('game')!;
const hudRoot = document.getElementById('hud')!;
const menu = document.getElementById('menu')!;

let game: Game | null = null;

/**
 * Pro needs hotkeys, right-click and box select. Browsers can't see a keyboard
 * directly, so offer Pro when there's a mouse or trackpad, or once any key is pressed.
 */
const finePointer = matchMedia('(any-pointer: fine)');
let sawKey = false;
const proOk = (): boolean => sawKey || finePointer.matches;
let lastMode: ModeId = proOk() && !matchMedia('(pointer: coarse)').matches ? 'pro' : 'casual';

/** Which menu screen is up: the main one, or a mode's tutorial list. */
let screen: 'main' | ModeId = 'main';
const refreshMenu = (): void => {
  // The online screens share this element but draw themselves; redrawing here would throw the player out of them.
  if (menu.hidden || menu.querySelector('.online')) return;
  if (screen === 'main') showMenu();
  else showTutorials(screen);
};
window.addEventListener(
  'keydown',
  () => {
    sawKey = true;
    refreshMenu();
  },
  { once: true },
);
finePointer.addEventListener('change', refreshMenu);

// How many AI teams a normal game has. ?rivals=N overrides it for this visit.
const RIVALS_KEY = 'mindblobs.rivals.v1';
const rivalsParam = Number(new URLSearchParams(location.search).get('rivals'));
let rivals = rivalsParam ? clampRivals(rivalsParam) : null;
const getRivals = (): number => (rivals ??= clampRivals(Number(platform.storage.getItem(RIVALS_KEY)) || DEFAULT_RIVALS));
function setRivals(n: number): void {
  rivals = clampRivals(n);
  platform.storage.setItem(RIVALS_KEY, String(rivals));
}

const hex = (c: number): string => `#${c.toString(16).padStart(6, '0')}`;

// Which map a normal game uses. ?map=lakes&size=large override it for this visit.
const MAP_KEY = 'mindblobs.map.v1';
let mapPick: { map: MapId; size: MapSize } | null = null;
function getMap(): { map: MapId; size: MapSize } {
  if (mapPick) return mapPick;
  let saved: { map?: unknown; size?: unknown } = {};
  try {
    saved = JSON.parse(platform.storage.getItem(MAP_KEY) ?? '{}') as typeof saved;
  } catch {
    // Junk saved: use the defaults.
  }
  const q = new URLSearchParams(location.search);
  const map = q.get('map') ?? saved.map;
  const size = q.get('size') ?? saved.size;
  mapPick = { map: isMapId(map) ? map : 'meadow', size: isMapSize(size) ? size : 'medium' };
  return mapPick;
}
function setMap(change: Partial<{ map: MapId; size: MapSize }>): void {
  mapPick = { ...getMap(), ...change };
  platform.storage.setItem(MAP_KEY, JSON.stringify(mapPick));
}

function rivalsPicker(): string {
  const n = getRivals();
  const buttons = Array.from({ length: MAX_RIVALS }, (_, i) => i + 1)
    .map((k) => `<button data-rivals="${k}" class="${k === n ? 'on' : ''}" aria-pressed="${k === n}">${k}</button>`)
    .join('');
  const teams = teamDefs(n).slice(2);
  const dots = teams.map((t) => `<span class="dot" style="background:${hex(t.color)}" title="${esc(t.name)}"></span>`).join('');
  return `<div class="rivals">
      <span class="lbl">Rival teams</span>
      <div class="seg" role="group" aria-label="Rival teams">${buttons}</div>
      <span class="dots" title="${esc(teams.map((t) => t.name).join(', '))}">${dots}</span>
    </div>`;
}

function stopGame(): void {
  game?.destroy();
  game = null;
  menu.hidden = false;
}

const esc = (s: string): string => s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);

const soundButton = (): string =>
  `<button class="menu-sound" data-sound title="Sound on/off">${sound.isMuted ? '🔇' : '🔊'}</button>`;

function bindSound(): void {
  menu.querySelector('[data-sound]')?.addEventListener('click', () => {
    sound.toggle();
    refreshMenu();
  });
}

function learnButton(mode: ModeId, label: string): string {
  const all = levelsFor(mode);
  const done = all.filter((l) => completed(mode).has(l.id)).length;
  return `<button data-tuts="${mode}">🎓 ${label} <small>${done}/${all.length}${done === all.length ? ' ✓' : ''}</small></button>`;
}

function showMenu(): void {
  stopGame();
  screen = 'main';
  const pro = proOk();
  const rec = (id: ModeId): string => (lastMode === id || !pro ? 'rec' : '');
  menu.innerHTML = `${soundButton()}
    <div class="menu-card">
      <div class="logo"><span class="blob b1"></span><span class="blob b2"></span><span class="blob b3"></span></div>
      <h1>Mind Blobs</h1>
      <p class="tag">Grow an empire by winning hearts, not fights.</p>
      <div class="modes ${pro ? '' : 'single'}">
        <button data-mode="casual" class="${rec('casual')}">
          <span class="ico">📱</span><b>${pro ? 'Casual' : 'BEGIN'}</b><small>Relaxed pace · tap to play · simple traits</small>
        </button>
        ${
          pro
            ? `<button data-mode="pro" class="${rec('pro')}">
          <span class="ico">🖥️</span><b>Pro</b><small>Fast · hotkeys & box select · every stat</small>
        </button>`
            : ''
        }
      </div>
      ${rivalsPicker()}
      ${mapPicker(getMap().map, getMap().size)}
      ${onlineAvailable() ? '<button class="online-btn" data-online>🌐 Play online with friends</button>' : ''}
      <div class="learn ${pro ? '' : 'single'}">
        ${pro ? learnButton('casual', 'Casual tutorials') + learnButton('pro', 'Pro tutorials') : learnButton('casual', 'Tutorials')}
      </div>
      ${pro ? '' : '<p class="pro-note">🖥️ Pro mode needs a keyboard and mouse. Play it on a computer.</p>'}
      <ul class="how">
        <li>💗 <b>Befriend</b> strangers: charming, kind, honest blobs win them over.</li>
        <li>🏫 Build schools, labs and markets. Houses give room for babies.</li>
        <li>💥 Violence is fast but <b>police arrest attackers</b>, and others will trust you less.</li>
        <li>🔬 Higher tech = smarter, faster police.</li>
        <li>🌍 Win by leading most of the world's blobs.</li>
      </ul>
    </div>`;
  menu.querySelectorAll<HTMLButtonElement>('[data-mode]').forEach((b) =>
    b.addEventListener('click', () => void start(b.dataset.mode as ModeId)),
  );
  menu.querySelectorAll<HTMLButtonElement>('[data-tuts]').forEach((b) =>
    b.addEventListener('click', () => showTutorials(b.dataset.tuts as ModeId)),
  );
  menu.querySelector('[data-online]')?.addEventListener('click', () => online.open());
  menu.querySelectorAll<HTMLButtonElement>('[data-map]').forEach((b) =>
    b.addEventListener('click', () => {
      setMap({ map: b.dataset.map as MapId });
      showMenu();
    }),
  );
  menu.querySelectorAll<HTMLButtonElement>('[data-size]').forEach((b) =>
    b.addEventListener('click', () => {
      setMap({ size: b.dataset.size as MapSize });
      showMenu();
    }),
  );
  menu.querySelectorAll<HTMLButtonElement>('[data-rivals]').forEach((b) =>
    b.addEventListener('click', () => {
      setRivals(Number(b.dataset.rivals));
      showMenu();
    }),
  );
  bindSound();
}

/** The level list for one mode, with ticks for the ones you've finished. */
function showTutorials(mode: ModeId): void {
  stopGame();
  screen = mode;
  const levels = levelsFor(mode);
  const done = completed(mode);
  const upNext = levels.find((l) => !done.has(l.id));
  const single = !proOk();
  menu.innerHTML = `${soundButton()}
    <div class="menu-card tuts">
      <div class="tuts-h">
        <button data-back title="Back">←</button>
        <h2>🎓 ${single ? 'Tutorials' : `${MODES[mode].label} tutorials`}</h2>
        <span class="count">${levels.filter((l) => done.has(l.id)).length}/${levels.length}</span>
      </div>
      <p class="tag">Little levels that show one or two ideas each. Play them in any order.</p>
      <ol class="levels">
        ${levels
          .map((l, i) => {
            const cls = done.has(l.id) ? 'done' : l === upNext ? 'up' : '';
            return `<li><button data-level="${l.id}" class="${cls}">
              <span class="n">${done.has(l.id) ? '✓' : i + 1}</span>
              <span class="ico">${l.icon}</span>
              <span class="t"><b>${esc(l.title)}</b><small>${esc(l.teaches)}</small></span>
              <span class="go">${done.has(l.id) ? 'Again' : 'Play ▶'}</span>
            </button></li>`;
          })
          .join('')}
      </ol>
      <div class="tuts-foot">
        <span>${upNext ? '' : '🎉 All done! You’re ready for a real game.'}</span>
        ${done.size ? '<button data-reset>Clear ticks</button>' : ''}
      </div>
    </div>`;
  menu.querySelector('[data-back]')!.addEventListener('click', showMenu);
  menu.querySelector('[data-reset]')?.addEventListener('click', () => {
    resetProgress(mode);
    showTutorials(mode);
  });
  menu.querySelectorAll<HTMLButtonElement>('[data-level]').forEach((b) =>
    b.addEventListener('click', () => void start(mode, b.dataset.level)),
  );
  bindSound();
}

/** True after the first game this visit: from then on, starting another is a natural break for an ad. */
let playedOnce = false;
let starting = false;

async function start(id: ModeId, levelId?: string): Promise<void> {
  if (starting) return;
  starting = true;
  try {
    // Portals want ads only at natural breaks, never before the very first game.
    if (playedOnce) await platform.commercialBreak();
    playedOnce = true;
    await launch(id, levelId);
  } finally {
    starting = false;
  }
}

async function launch(id: ModeId, levelId?: string): Promise<void> {
  game?.destroy();
  game = null;
  lastMode = id;
  menu.hidden = true;
  const seed = Number(new URLSearchParams(location.search).get('seed')) || Date.now();
  const level = levelId ? findLevel(id, levelId) : undefined;
  const list = levelsFor(id);
  const next = level ? (list[list.indexOf(level) + 1] ?? null) : null;
  game = await Game.start(
    MODES[id],
    host,
    hudRoot,
    {
      onMenu: showMenu,
      onRestart: () => void start(id, level?.id),
      tutorial: level && {
        level,
        next,
        done: () => markCompleted(id, level.id),
        onNext: () => void start(id, next?.id),
        onList: () => showTutorials(id),
        onPlay: () => void start(id),
      },
    },
    seed,
    level ? {} : { rivals: getRivals(), map: getMap().map, mapSize: getMap().size },
  );
  if (import.meta.env.DEV) (window as unknown as { __game: Game }).__game = game;
}

// ─── online ───

const online = new Online({
  menu,
  back: showMenu,
  play: launchOnline,
  stop: () => {
    game?.destroy();
    game = null;
  },
});

async function launchOnline(o: OnlineOptions): Promise<Game> {
  game?.destroy();
  game = null;
  menu.hidden = true;
  const g = await Game.start(
    MODES[o.setup.mode],
    host,
    hudRoot,
    { onMenu: () => online.menuTap(), onRestart: () => online.rematch() },
    undefined,
    {},
    o,
  );
  game = g;
  if (import.meta.env.DEV) (window as unknown as { __game: Game }).__game = g;
  return g;
}

// ─── sound and page behaviour ───

// Browsers start audio only from a gesture, and iOS can suspend it again, so every gesture retries.
for (const ev of ['pointerdown', 'touchend', 'keydown'] as const) {
  window.addEventListener(ev, () => sound.unlock(), { capture: true, passive: true });
}
document.addEventListener('click', (e) => {
  if ((e.target as HTMLElement).closest?.('button')) sound.play('tap');
}, true);
document.addEventListener('visibilitychange', () => sound.hold('hidden', document.hidden));
// Inside a portal's iframe, arrow keys would scroll the page around the game.
window.addEventListener('keydown', (e) => {
  if (e.key.startsWith('Arrow') && (e.target as HTMLElement)?.tagName !== 'INPUT') e.preventDefault();
});

// ─── boot ───

async function boot(): Promise<void> {
  await platform.init();
  platform.onAd((state) => {
    // Paused with taps blocked from the request on (portals ask for that); silent only once the ad plays.
    sound.hold('ad', state === 'playing');
    game?.setAdHold(state !== 'idle');
    document.body.classList.toggle('ad-wait', state !== 'idle');
  });
  document.getElementById('boot')?.remove();
  // Portals want "loading finished" before any "gameplay start".
  platform.loadingDone();
  // ?mode=casual|pro skips the menu; add &tut=<level id> to jump into a tutorial.
  const params = new URLSearchParams(location.search);
  const param = params.get('mode');
  const room = params.get('room')?.toUpperCase().replace(/[^A-Z]/g, '').slice(0, 4);
  if (room && onlineAvailable()) online.open(room);
  else if (param === 'casual' || param === 'pro') await start(param, params.get('tut') ?? undefined);
  else showMenu();
}

void boot();
