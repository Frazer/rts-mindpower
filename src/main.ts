import './style.css';
import { Game } from './game';
import { MODES, type ModeId } from './modes';

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

const refreshMenu = (): void => {
  if (!menu.hidden) showMenu();
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

function showMenu(): void {
  game?.destroy();
  game = null;
  menu.hidden = false;
  const pro = proOk();
  const rec = (id: ModeId): string => (lastMode === id || !pro ? 'rec' : '');
  menu.innerHTML = `
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
}

async function start(id: ModeId): Promise<void> {
  game?.destroy();
  lastMode = id;
  menu.hidden = true;
  const seed = Number(new URLSearchParams(location.search).get('seed')) || Date.now();
  game = await Game.start(MODES[id], host, hudRoot, { onMenu: showMenu, onRestart: () => void start(id) }, seed);
  if (import.meta.env.DEV) (window as unknown as { __game: Game }).__game = game;
}

const param = new URLSearchParams(location.search).get('mode');
if (param === 'casual' || param === 'pro') void start(param);
else showMenu();
