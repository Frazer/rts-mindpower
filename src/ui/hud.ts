import type { ModeConfig } from '../modes';
import {
  ADULT_AGE,
  BUILD_MENU,
  BUILDINGS,
  MAX_TECH,
  NEUTRAL,
  FOUNTAIN_RADIUS,
  PLAYER,
  SCHOOL_RADIUS,
  buildCost,
  policeDetectRadius,
  policeSkill,
  techThreshold,
} from '../sim/config';
import { NEGATIVE_TRAITS, TRAITS, TRAIT_INFO, talkScore, type TraitKey } from '../sim/traits';
import type { Blob, Building, BuildingKind, Job } from '../sim/types';
import type { World } from '../sim/world';
import type { Progress } from '../tutorials';

export type PanelAction =
  | 'befriend'
  | 'attack'
  | 'teach'
  | 'usurp'
  | 'move'
  | 'stop'
  | 'nearby'
  | 'sendFriend'
  | 'sendBonker'
  | 'sendUsurp';
export type CommandMode = 'befriend' | 'attack' | 'teach' | 'usurp' | 'move' | null;
export type TeamTab = 'charm' | 'teaching' | 'smarts' | 'money' | 'power' | 'hot';
export type TeamAct = 'select' | 'teacher' | 'recruiter' | 'teachThem';

interface TabDef {
  key: TeamTab;
  icon: string;
  label: string;
  desc: string;
  score: (b: Blob) => number;
  act?: TeamAct;
}

export const TEAM_TABS: readonly TabDef[] = [
  { key: 'charm', icon: '💬', label: 'Charm', desc: 'Best at befriending strangers. Make them Recruiters.', score: (b) => talkScore(b.traits), act: 'recruiter' },
  { key: 'teaching', icon: '📚', label: 'Teaching', desc: 'Best at passing on their traits. Make them Teachers.', score: (b) => b.traits.teaching, act: 'teacher' },
  { key: 'smarts', icon: '🧠', label: 'Smarts', desc: 'Science and intelligence: they drive your research.', score: (b) => 0.6 * b.traits.science + 0.4 * b.traits.intelligence },
  { key: 'money', icon: '💰', label: 'Money', desc: 'Financial smarts: they earn your gold.', score: (b) => b.traits.finance },
  { key: 'power', icon: '💪', label: 'Power', desc: 'Strong and fit: fast walkers and tough in a scrap.', score: (b) => (b.traits.strength + b.traits.fitness) / 2 },
  { key: 'hot', icon: '😠', label: 'Hot heads', desc: 'Most likely to start fights. Send teachers to calm them down.', score: (b) => b.traits.violence, act: 'teachThem' },
];

export const JOBS: Record<Job, { icon: string; label: string; desc: string }> = {
  social: {
    icon: '💬',
    label: 'Social',
    desc: 'Hangs around home chatting: keeps teammates loyal, wins over visitors, defends your buildings and has the most babies.',
  },
  teacher: { icon: '🎓', label: 'Teacher', desc: 'Keeps teaching the nearby teammates it can help most.' },
  recruiter: { icon: '🌸', label: 'Recruiter', desc: 'Keeps befriending the strangers nearest to it.' },
};

export interface HudHandlers {
  build(kind: BuildingKind): void;
  action(a: PanelAction): void;
  focus(trait: TraitKey): void;
  speed(s: number): void;
  pause(): void;
  menu(): void;
  restart(): void;
  minimap(wx: number, wy: number): void;
  job(job: Job): void;
  team(tab: TeamTab | null): void;
  teamPick(id: number): void;
  teamAct(act: TeamAct, ids: number[]): void;
  sound(): void;
  /** Watch a rewarded ad for gold. */
  gift(): void;
}

/** What the tutorial card shows. */
export interface TutCard {
  icon: string;
  title: string;
  step: number;
  steps: number;
  text: string;
  sub: string;
  progress: Progress | null;
}

export interface TutDone {
  icon: string;
  title: string;
  outro: string;
  next: { icon: string; title: string } | null;
  onNext(): void;
  onList(): void;
  onPlay(): void;
}

export interface HudState {
  selected: Blob[];
  building: Building | null;
  buildMode: BuildingKind | null;
  command: CommandMode;
  speed: number;
  paused: boolean;
  team: TeamTab | null;
  muted: boolean;
  /** Rewarded-ad offer: null when there are no ads (or in tutorials), else whether it's ready now. */
  gift: { ready: boolean; gold: number } | null;
}

const BUILD_KEYS: Record<string, string> = { house: 'Q', school: 'W', lab: 'E', market: 'R', police: 'T', fountain: 'Y' };
const MOOD: Record<Blob['mood'], string> = { calm: '🙂', happy: '😄', angry: '😠', scared: '😨', sad: '😢' };
const CASUAL_FOCUS: TraitKey[] = ['science', 'kindness', 'teaching', 'honesty', 'finance'];

const hex = (c: number): string => '#' + c.toString(16).padStart(6, '0');
const pct = (v: number): string => `${Math.round(v * 100)}%`;
const esc = (s: string): string => s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);

/** Least height of map (CSS px) kept clear under the tutorial card on small screens. */
const MAP_ROOM = 120;

/** DOM overlay: top bar, build bar, selection panel, toasts, log, minimap, end screen. */
export class Hud {
  private readonly top: HTMLElement;
  private readonly score: HTMLElement;
  private readonly panel: HTMLElement;
  private readonly buildBar: HTMLElement;
  private readonly toasts: HTMLElement;
  private readonly hintEl: HTMLElement;
  private readonly logEl: HTMLElement;
  private readonly mini: HTMLCanvasElement;
  private readonly endEl: HTMLElement;
  private readonly tutEl: HTMLElement;
  private readonly pointsEl: HTMLElement;
  private tutKey = '';
  private panelKey = '';
  private hintHtml = '';
  private endShown = false;
  private teamOpen = false;
  private teamCache = { tab: '' as string, t: -Infinity, ids: [] as number[] };

  constructor(private readonly root: HTMLElement, private readonly mode: ModeConfig, private readonly h: HudHandlers) {
    const keys = mode.hotkeys;
    root.hidden = false;
    root.className = `hud mode-${mode.id}`;
    root.innerHTML = `
      <div class="top">
        <div class="stats">
          <div class="chip me"><span class="dot" style="background:var(--blue)"></span><b>You</b></div>
          <div class="chip" title="Population / room"><span>👥</span><b data-v="pop"></b></div>
          <div class="chip gold" title="Gold: blobs with Financial Smarts earn it, markets boost it"><i class="coin"></i><b data-v="gold"></b></div>
          <div class="chip" title="Tech: better police, persuasion and teaching"><span>🔬</span><b data-v="tech"></b><i class="mini"><i data-w="techp"></i></i></div>
          <div class="chip" title="Reputation: violence lowers it, arrests and kindness raise it"><span>⭐</span><b data-v="rep"></b></div>
          <div class="chip goal" title="Your share of all blobs (goal to win)"><span>🌍</span><b data-v="share"></b></div>
          <button data-gift class="gift" hidden></button>
        </div>
        <div class="score"></div>
        <div class="ctrl">
          ${mode.speeds.map((s) => `<button data-speed="${s}">${s}×</button>`).join('')}
          <button data-team class="team" title="Your team: find your best blobs and give them jobs${keys ? ' (Tab)' : ''}">👥<span> Team</span></button>
          <button data-pause title="Pause${keys ? ' (Space)' : ''}">⏸</button>
          <button data-sound title="Sound on/off${keys ? ' (M)' : ''}">🔊</button>
          <button data-menu title="Menu">☰</button>
        </div>
      </div>
      <div class="tut-points"></div>
      <div class="toasts"></div>
      <div class="hint" hidden></div>
      <div class="panel" hidden></div>
      <div class="tut" hidden></div>
      <div class="build">
        ${BUILD_MENU.map(
          (k) => `<button data-build="${k}" title="${esc(BUILDINGS[k].desc)}">
            <span class="ico">${BUILDINGS[k].icon}</span><span class="lbl">${BUILDINGS[k].label.replace(' Station', '').replace('Friendship ', '')}</span>
            <span class="eff">${BUILDINGS[k].short}</span>
            <small class="cost"><i class="coin"></i><span data-cost="${k}"></span></small>${keys ? `<kbd>${BUILD_KEYS[k]}</kbd>` : ''}</button>`,
        ).join('')}
      </div>
      <div class="log" ${mode.eventLog ? '' : 'hidden'}></div>
      <canvas class="minimap" ${mode.minimap ? '' : 'hidden'}></canvas>
      <div class="end" hidden></div>`;

    const q = <T extends HTMLElement>(sel: string): T => root.querySelector(sel) as T;
    this.top = q('.top');
    this.score = q('.score');
    this.panel = q('.panel');
    this.buildBar = q('.build');
    this.toasts = q('.toasts');
    this.hintEl = q('.hint');
    this.logEl = q('.log');
    this.mini = q('.minimap');
    this.endEl = q('.end');
    this.tutEl = q('.tut');
    this.pointsEl = q('.tut-points');
    this.tutEl.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).closest('[data-tut-min]')) this.tutEl.classList.toggle('min');
      this.placeTut();
    });

    this.top.addEventListener('click', (e) => {
      const t = (e.target as HTMLElement).closest('button');
      if (!t) return;
      if (t.dataset.speed) h.speed(Number(t.dataset.speed));
      else if ('pause' in t.dataset) h.pause();
      else if ('team' in t.dataset) h.team(this.teamOpen ? null : 'charm');
      else if ('sound' in t.dataset) h.sound();
      else if ('gift' in t.dataset) h.gift();
      else if ('menu' in t.dataset) h.menu();
    });
    this.buildBar.addEventListener('click', (e) => {
      const t = (e.target as HTMLElement).closest<HTMLElement>('[data-build]');
      if (t) h.build(t.dataset.build as BuildingKind);
    });
    this.panel.addEventListener('click', (e) => {
      const el = e.target as HTMLElement;
      const a = el.closest<HTMLElement>('[data-a]');
      if (a) h.action(a.dataset.a as PanelAction);
      const f = el.closest<HTMLElement>('[data-focus]');
      if (f) h.focus(f.dataset.focus as TraitKey);
      const j = el.closest<HTMLElement>('[data-job]');
      if (j) h.job(j.dataset.job as Job);
      const tab = el.closest<HTMLElement>('[data-tab]');
      if (tab) h.team(tab.dataset.tab as TeamTab);
      if (el.closest('[data-team-close]')) h.team(null);
      const pick = el.closest<HTMLElement>('[data-pick]');
      if (pick) h.teamPick(Number(pick.dataset.pick));
      const ta = el.closest<HTMLElement>('[data-team-act]');
      if (ta) h.teamAct(ta.dataset.teamAct as TeamAct, this.teamCache.ids.slice(0, Number(ta.dataset.n)));
    });
    const miniPick = (e: PointerEvent): void => {
      if (e.buttons === 0 && e.type === 'pointermove') return;
      const r = this.mini.getBoundingClientRect();
      const fx = (e.clientX - r.left) / r.width;
      const fy = (e.clientY - r.top) / r.height;
      h.minimap(fx, fy);
    };
    this.mini.addEventListener('pointerdown', miniPick);
    this.mini.addEventListener('pointermove', miniPick);
  }

  destroy(): void {
    this.root.innerHTML = '';
    this.root.hidden = true;
  }

  // ───────────────────────────── per update (~5 Hz) ─────────────────────────────

  update(w: World, s: HudState): void {
    const me = w.factions[PLAYER];
    const total = Math.max(1, w.blobs.length);
    const lvl = me.tech;
    const lo = techThreshold(lvl);
    const hi = techThreshold(lvl + 1);
    fill(this.top, {
      pop: `${me.pop}/${me.cap}`,
      gold: `${Math.floor(me.gold)}`,
      tech: lvl >= MAX_TECH ? 'MAX' : `${lvl}`,
      rep: pct(me.reputation),
      share: `${Math.round((100 * me.pop) / total)}% / ${Math.round(this.mode.winShare * 100)}%`,
    }, { techp: lvl >= MAX_TECH ? 1 : (me.research - lo) / (hi - lo) });

    this.score.innerHTML = w.factions
      .filter((f) => f.isPlayer || f.pop > 0)
      .map((f) => {
        const label = f.isNeutral ? 'Wild' : f.isPlayer ? 'You' : esc(f.name);
        const tech = f.isNeutral ? '' : ` <small>T${f.tech}</small>`;
        return `<span class="sc" title="${esc(f.name)}"><span class="dot" style="background:${hex(f.color)}"></span>${label} <b>${f.pop}</b>${tech}</span>`;
      })
      .join('');

    for (const b of this.top.querySelectorAll<HTMLButtonElement>('[data-speed]')) {
      b.classList.toggle('on', Number(b.dataset.speed) === s.speed && !s.paused);
    }
    const pauseBtn = this.top.querySelector<HTMLButtonElement>('[data-pause]')!;
    this.teamOpen = s.team !== null;
    this.top.querySelector<HTMLButtonElement>('[data-team]')!.classList.toggle('on', this.teamOpen);
    pauseBtn.classList.toggle('on', s.paused);
    pauseBtn.textContent = s.paused ? '▶' : '⏸';
    const soundBtn = this.top.querySelector<HTMLButtonElement>('[data-sound]')!;
    const icon = s.muted ? '🔇' : '🔊';
    if (soundBtn.textContent !== icon) soundBtn.textContent = icon;
    soundBtn.classList.toggle('off', s.muted);
    const gift = this.top.querySelector<HTMLButtonElement>('[data-gift]')!;
    gift.hidden = !s.gift?.ready;
    if (s.gift?.ready && !gift.textContent) {
      gift.innerHTML = `📺<span> +${s.gift.gold}</span>`;
      gift.title = `Watch a short ad to get ${s.gift.gold} gold`;
    }

    for (const k of BUILD_MENU) {
      const cost = buildCost(me, k);
      const btn = this.buildBar.querySelector<HTMLButtonElement>(`[data-build="${k}"]`)!;
      btn.classList.toggle('poor', me.gold < cost);
      btn.classList.toggle('on', s.buildMode === k);
      btn.querySelector<HTMLElement>(`[data-cost="${k}"]`)!.textContent = `${cost}`;
    }

    // On phones the panel would cover the map while you pick a target, so it steps aside.
    this.root.classList.toggle('picking', !!(s.command || s.buildMode));
    this.renderPanel(w, s);
  }

  private renderPanel(w: World, s: HudState): void {
    const out = s.team
      ? this.teamPanel(w, s.team)
      : s.building
        ? this.buildingPanel(w, s.building)
        : s.selected.length
          ? this.blobPanel(w, s)
          : null;
    if (!out) {
      if (!this.panel.hidden) {
        this.panel.hidden = true;
        this.placeTut();
      }
      this.panelKey = '';
      return;
    }
    this.panel.hidden = false;
    if (out.key !== this.panelKey) {
      this.panel.innerHTML = out.html;
      this.panelKey = out.key;
    }
    fill(this.panel, out.vals, out.widths);
    this.placeTut();
  }

  private blobPanel(w: World, s: HudState): PanelOut {
    const blobs = s.selected;
    const b = blobs[0];
    const f = w.factions[b.faction];
    const own = b.faction === PLAYER;
    const keys = this.mode.hotkeys;
    const vals: Record<string, string> = {};
    const widths: Record<string, number> = {};
    const commandable = own && blobs.some((x) => x.jail <= 0 && x.role !== 'police');
    const kbd = (k: string): string => (keys ? `<kbd>${k}</kbd>` : '');

    let head: string;
    let sub: string;
    if (blobs.length === 1) {
      const role =
        b.role === 'police'
          ? '🚓 Police'
          : b.job !== 'social'
            ? `${JOBS[b.job].icon} ${JOBS[b.job].label}`
            : b.role === 'ambassador'
              ? '🌸 Ambassador'
              : b.age < ADULT_AGE
                ? '🍼 Kid'
                : 'Citizen';
      head = `<span class="dot" style="background:${hex(f.color)}"></span><b>${esc(b.name)}</b><span class="tag">${role}</span><span data-v="mood"></span>`;
      sub = `${esc(f.isNeutral ? 'Wild wanderer' : f.name)} · age <span data-v="age"></span> · <span data-v="status"></span>`;
      vals.mood = MOOD[b.mood];
      vals.age = `${Math.floor(b.age)}`;
      vals.status = b.jail > 0 ? `🔒 jail ${Math.ceil(b.jail)}s` : b.heat > 0 ? '🚨 wanted' : orderText(w, b);
    } else {
      head = `<span class="dot" style="background:${hex(f.color)}"></span><b>${blobs.length} blobs</b>`;
      sub = `${esc(f.name)} · <span data-v="status"></span>`;
      const busy = blobs.filter((x) => x.order.kind !== 'none').length;
      vals.status = `${busy} busy`;
    }

    const avg = (fn: (x: Blob) => number): number => blobs.reduce((a, x) => a + fn(x), 0) / blobs.length;
    widths.loy = avg((x) => x.loyalty);
    widths.hp = avg((x) => x.health);
    widths.charm = avg((x) => talkScore(x.traits));
    widths.power = avg((x) => (x.traits.strength + x.traits.fitness) / 2);
    const meters = `
      <div class="meters">
        ${meter('🛡️ Loyalty', 'loy', 'Below zero, they switch teams')}
        ${meter('❤️ Health', 'hp')}
        ${meter('💬 Charm', 'charm', 'How persuasive they are')}
        ${meter('💪 Power', 'power', 'Strength + fitness')}
      </div>`;

    let traits: string;
    let traitKey = '';
    if (this.mode.showNumbers) {
      traits = `<div class="traits">${TRAITS.map(
        (t) => `<div class="tr ${NEGATIVE_TRAITS.has(t.key) ? 'neg' : ''}" title="${t.label}: ${t.effect}"><span>${t.icon}</span><span class="tl">${t.label}</span><i class="bar"><i data-w="t-${t.key}"></i></i><b data-v="t-${t.key}"></b></div>`,
      ).join('')}</div>`;
      for (const t of TRAITS) {
        const v = avg((x) => x.traits[t.key]);
        widths[`t-${t.key}`] = v;
        vals[`t-${t.key}`] = `${Math.round(v * 100)}`;
      }
    } else {
      const ranked = TRAITS.filter((t) => !NEGATIVE_TRAITS.has(t.key))
        .map((t) => ({ t, v: avg((x) => x.traits[t.key]) }))
        .sort((a, z) => z.v - a.v)
        .slice(0, 3);
      const hot = avg((x) => x.traits.violence) > 0.6;
      traitKey = ranked.map((r) => r.t.key).join(',') + (hot ? ',hot' : '');
      traits = `<div class="chips"><span class="clbl">Best at</span>${ranked.map((r) => `<span class="tchip" title="${r.t.label}: ${r.t.effect}">${r.t.icon} ${r.t.adj}</span>`).join('')}${
        hot ? `<span class="tchip neg">😠 Hot-headed</span>` : ''
      }</div>`;
    }

    let actions = '';
    let jobKey = '';
    if (commandable) {
      const on = (c: CommandMode): string => (s.command === c ? 'on' : '');
      const jobs = new Set(blobs.filter((x) => x.role !== 'police').map((x) => x.job));
      const job = jobs.size === 1 ? [...jobs][0] : null;
      jobKey = job ?? 'mixed';
      actions = `<div class="acts">
        <button data-a="befriend" class="good ${on('befriend')}" title="Tap a stranger or a crowd: your blobs spread out and befriend them all">💗 Befriend${kbd('F')}</button>
        <button data-a="teach" class="teach ${on('teach')}" title="Pass this blob's best traits to a teammate">📚 Teach${kbd('C')}</button>
        <button data-a="usurp" class="${on('usurp')}" title="Take over another team's building by outnumbering the blobs there">🏳️ Take over${kbd('U')}</button>
        <button data-a="attack" class="danger ${on('attack')}" title="Fast, but police arrest attackers">💥 Bonk${kbd('X')}</button>
        <button data-a="move" class="${on('move')}">🚶 Move${kbd('G')}</button>
        <button data-a="stop">✋ Stop${kbd('S')}</button>
        ${blobs.length === 1 ? `<button data-a="nearby" title="Select your free blobs around this one">👥 Select nearby</button>` : ''}
      </div>
      <div class="jobs"><span class="jl">Job</span>${(Object.keys(JOBS) as Job[])
        .map((k) => `<button data-job="${k}" class="${job === k ? 'on' : ''}" title="${JOBS[k].desc}">${JOBS[k].icon} ${JOBS[k].label}</button>`)
        .join('')}</div>
      <p class="note dim">${job ? JOBS[job].desc : 'Mixed jobs. Pick one to give them all the same job.'}</p>`;
    } else if (own && b.role === 'police') {
      actions = `<p class="note">🚓 Officers patrol your land and arrest anyone who turns violent — even your own blobs.</p>`;
    } else if (!own) {
      actions = `<div class="acts">
        <button data-a="sendFriend" class="good" title="Your 3 most charming free blobs go and befriend this blob and those around it">💗 Send 3 friends</button>
        <button data-a="sendBonker" class="danger">💥 Send a bonker</button>
      </div>`;
    }

    const key = [
      'blob',
      blobs.map((x) => x.id).join(','),
      b.faction,
      b.role,
      b.jail > 0,
      commandable,
      s.command,
      traitKey,
      jobKey,
      b.job,
    ].join('|');
    const html = `<div class="p-head">${head}</div><div class="p-sub">${sub}</div>${meters}${traits}${actions}`;
    return { key, html, vals, widths };
  }

  private teamPanel(w: World, tab: TeamTab): PanelOut {
    const def = TEAM_TABS.find((t) => t.key === tab) ?? TEAM_TABS[0];
    const mine = w.blobs.filter((b) => b.alive && b.faction === PLAYER && b.role !== 'police');
    // Re-rank every couple of seconds so rows don't jump around under your finger.
    const c = this.teamCache;
    if (c.tab !== tab || w.time - c.t > 2 || c.ids.some((id) => !w.byId.get(id) || w.byId.get(id)!.faction !== PLAYER)) {
      c.tab = tab;
      c.t = w.time;
      c.ids = [...mine].sort((a, z) => def.score(z) - def.score(a)).slice(0, this.mode.showNumbers ? 8 : 6).map((b) => b.id);
    }
    const vals: Record<string, string> = {};
    const widths: Record<string, number> = {};
    const teachers = mine.filter((b) => b.job === 'teacher').length;
    const recruiters = mine.filter((b) => b.job === 'recruiter').length;
    vals.tch = `${teachers}`;
    vals.rec = `${recruiters}`;
    vals.les = `${w.factions[PLAYER].stats.lessons}`;
    const rows = c.ids
      .map((id, i) => {
        const b = w.byId.get(id)!;
        const v = def.score(b);
        widths[`r${i}`] = v;
        vals[`r${i}`] = `${Math.round(v * 100)}`;
        vals[`j${i}`] = b.job !== 'social' ? JOBS[b.job].icon : b.jail > 0 ? '🔒' : b.age < ADULT_AGE ? '🍼' : '';
        return `<button class="row" data-pick="${id}" title="Select ${esc(b.name)} and look at them">
          <span class="nm">${esc(b.name)}</span><i class="bar ${tab === 'hot' ? 'neg' : ''}"><i data-w="r${i}"></i></i>${
            this.mode.showNumbers ? `<b data-v="r${i}"></b>` : ''
          }<span class="jb" data-v="j${i}"></span></button>`;
      })
      .join('');
    const actBtn: Record<TeamAct, string> = {
      select: `<button data-team-act="select" data-n="5" title="Select the top 5, then tap Befriend and tap a crowd">👆 Select top 5</button>`,
      teacher: `<button data-team-act="teacher" data-n="3" class="teach">🎓 Make top 3 Teachers</button>`,
      recruiter: `<button data-team-act="recruiter" data-n="3" class="good">🌸 Make top 3 Recruiters</button>`,
      teachThem: `<button data-team-act="teachThem" data-n="3" class="teach">📚 Send teachers to top 3</button>`,
    };
    const html = `<div class="p-head"><b>👥 Your team</b><span class="tag">${mine.length} blobs</span><button class="x" data-team-close title="Close">✕</button></div>
      <div class="p-sub">🎓 <span data-v="tch"></span> teachers · 🌸 <span data-v="rec"></span> recruiters · 📚 <span data-v="les"></span> lessons given</div>
      <div class="tabs">${TEAM_TABS.map((t) => `<button data-tab="${t.key}" class="${t.key === tab ? 'on' : ''}">${t.icon} ${t.label}</button>`).join('')}</div>
      <p class="note dim">${def.desc}</p>
      <div class="roster">${rows || '<p class="note">No blobs yet.</p>'}</div>
      <div class="acts">${actBtn.select}${def.act ? actBtn[def.act] : ''}</div>`;
    return { key: `team|${tab}|${c.ids.join(',')}`, html, vals, widths };
  }

  private buildingPanel(w: World, b: Building): PanelOut {
    const def = BUILDINGS[b.kind];
    const f = w.factions[b.faction];
    const own = b.faction === PLAYER;
    const vals: Record<string, string> = {};
    const widths: Record<string, number> = {};
    let body = `<p class="note">${esc(def.desc)}</p>`;
    if (b.capture > 0 && b.captureBy >= 0) {
      const by = w.factions[b.captureBy];
      body += `<div class="meter capture" title="Outnumber the blobs standing here to take it over"><span>🏳️ ${
        own ? 'Being taken by' : b.captureBy === PLAYER ? 'You are taking it' : 'Being taken by'
      } ${b.captureBy === PLAYER ? '' : esc(by.name)}</span><i class="bar"><i data-w="cap"></i></i></div>`;
      widths.cap = b.capture;
      if (own) body += `<p class="note">⚠️ Send blobs to stand here: more of yours than theirs stops it.</p>`;
    }
    if (b.kind === 'fountain') {
      let visitors = 0;
      for (const x of w.blobs) if (x.faction !== b.faction && x.role !== 'police' && (x.x - b.x) ** 2 + (x.y - b.y) ** 2 < FOUNTAIN_RADIUS ** 2) visitors++;
      body += `<p class="note">💗 <b data-v="visitors"></b> strangers being befriended now</p>`;
      vals.visitors = `${visitors}`;
    }
    if (!own && !f.isNeutral) {
      body += `<div class="acts"><button data-a="sendUsurp" title="Your 5 nearest free blobs go and stand around it">🏳️ Send 5 to take it over</button></div>
        <p class="note dim">No fighting: if more of your blobs stand here than theirs, it slowly becomes yours.</p>`;
    }
    if (b.kind === 'hall') {
      body += `<p class="note">Room: <b data-v="room"></b> · Land radius <b data-v="land"></b></p>`;
      vals.room = `${f.pop}/${f.cap}`;
      vals.land = `${Math.round(w.territoryRadius(b.faction))}`;
    } else if (b.kind === 'police') {
      body += `<p class="note">Officers: <b data-v="cops"></b> · Skill <b data-v="skill"></b> · Sight <b data-v="sight"></b></p>
        <p class="note dim">Raise tech to make police sharper and faster.</p>`;
      vals.cops = `${f.police}`;
      vals.skill = pct(Math.min(1, policeSkill(f.tech)));
      vals.sight = `${policeDetectRadius(f.tech)}`;
    } else if (b.kind === 'school') {
      const opts = this.mode.showNumbers ? TRAITS.filter((t) => !NEGATIVE_TRAITS.has(t.key)).map((t) => t.key) : CASUAL_FOCUS;
      let learners = 0;
      for (const x of w.blobs) if (x.faction === b.faction && (x.x - b.x) ** 2 + (x.y - b.y) ** 2 < SCHOOL_RADIUS ** 2) learners++;
      body += `<p class="note">📚 <b data-v="learners"></b> blobs learning here now</p>`;
      vals.learners = `${learners}`;
      body += own
        ? `<p class="note"><b>Pick what it teaches:</b></p><div class="focus">${opts
            .map(
              (k) =>
                `<button data-focus="${k}" class="${b.focus === k ? 'on' : ''}"><span>${TRAIT_INFO[k].icon} ${TRAIT_INFO[k].label}</span><small>${TRAIT_INFO[k].effect}</small></button>`,
            )
            .join('')}</div>`
        : `<p class="note">Teaching: ${TRAIT_INFO[b.focus].icon} ${TRAIT_INFO[b.focus].label} · ${TRAIT_INFO[b.focus].effect}</p>`;
    }
    const html = `<div class="p-head"><span class="ico">${def.icon}</span><b>${def.label}</b><span class="tag" style="background:${hex(f.color)}55">${esc(
      f.isPlayer ? 'Yours' : f.name,
    )}</span></div>${body}`;
    return { key: `bld|${b.id}|${b.focus}|${b.faction}|${b.captureBy}|${b.capture > 0}`, html, vals, widths };
  }

  // ───────────────────────────── messages ─────────────────────────────

  toast(text: string, kind: 'good' | 'bad' | 'info' = 'info'): void {
    const el = document.createElement('div');
    el.className = `toast ${kind}`;
    el.textContent = text;
    this.toasts.prepend(el);
    while (this.toasts.children.length > 4) this.toasts.lastElementChild!.remove();
    setTimeout(() => el.classList.add('out'), 2800);
    setTimeout(() => el.remove(), 3300);
  }

  log(text: string, color: number): void {
    if (!this.mode.eventLog) return;
    const el = document.createElement('div');
    el.innerHTML = `<span class="dot" style="background:${hex(color)}"></span>${esc(text)}`;
    this.logEl.prepend(el);
    while (this.logEl.children.length > 10) this.logEl.lastElementChild!.remove();
  }

  /** Tutorial mode: show only the buildings this level uses, and the win goal only if it counts. */
  setTutorial(goal: boolean, build: readonly BuildingKind[]): void {
    this.root.classList.add('tut-on');
    this.top.querySelector<HTMLElement>('.chip.goal')!.hidden = !goal;
    for (const b of this.buildBar.querySelectorAll<HTMLElement>('[data-build]')) {
      b.hidden = !build.includes(b.dataset.build as BuildingKind);
    }
    this.buildBar.hidden = build.length === 0;
  }

  tutorial(c: TutCard | null): void {
    if (!c) {
      this.tutEl.hidden = true;
      this.tutKey = '';
      this.toasts.style.top = this.toasts.style.left = this.toasts.style.width = '';
      this.panel.style.maxHeight = '';
      return;
    }
    this.tutEl.hidden = false;
    const key = `${c.title}|${c.step}`;
    if (key !== this.tutKey) {
      this.tutKey = key;
      const dots = Array.from({ length: c.steps }, (_, i) => `<i class="${i < c.step ? 'did' : i === c.step ? 'now' : ''}"></i>`).join('');
      this.tutEl.innerHTML = `<button class="tut-h" data-tut-min title="Hide or show the steps">
          <span>${c.icon} ${esc(c.title)}</span><span class="dots" title="Step ${c.step + 1} of ${c.steps}">${dots}</span>
        </button>
        <div class="tut-b"><b>${esc(c.text)}</b>${c.sub ? `<small>${esc(c.sub)}</small>` : ''}
          <div class="tut-p" hidden><i class="bar"><i data-w="tp"></i></i><span data-v="tp"></span></div>
        </div>`;
      // A new step un-hides the card and pops it, so you notice.
      this.tutEl.classList.remove('min', 'next');
      void this.tutEl.offsetWidth;
      if (c.step > 0) this.tutEl.classList.add('next');
    }
    const bar = this.tutEl.querySelector<HTMLElement>('.tut-p')!;
    bar.hidden = !c.progress;
    if (c.progress) {
      const { n, of, label = '' } = c.progress;
      const shown = Math.max(0, Math.min(n, of));
      const text = label.startsWith('%') ? `${shown}${label}${of !== 100 ? ` · goal ${of}%` : ''}` : `${shown}/${of} ${label}`;
      fill(this.tutEl, { tp: text }, { tp: shown / of });
    }
    this.placeTut();
  }

  /**
   * The part of the screen the HUD leaves clear (CSS px). On phones the
   * selection panel can cover the lower half, so keep to the top.
   */
  freeArea(): { x0: number; y0: number; x1: number; y1: number } {
    const w = this.root.clientWidth;
    const h = this.root.clientHeight;
    // Upright phones have the panel across the bottom; everything else has it down the left side.
    const phone = w <= 700 && h > 500;
    const under = (el: HTMLElement): number => (el.hidden ? 0 : el.getBoundingClientRect().bottom);
    const y0 = Math.max(under(this.top), under(this.tutEl)) + 8;
    const y1 = phone ? h - 100 - 0.42 * h : h - 120;
    const x0 = phone ? 8 : w <= 700 ? Math.min(300, 0.48 * w) + 16 : 320;
    const x1 = w - (phone ? 8 : this.mode.eventLog ? 270 : 20);
    return { x0, y0, x1, y1: Math.max(y0 + MAP_ROOM, y1) };
  }

  /** Bobbing labels over things on the map, in screen px. Off-screen ones stick to the edge. */
  points(list: readonly { x: number; y: number; label: string }[]): void {
    const el = this.pointsEl;
    while (el.children.length < list.length) el.append(Object.assign(document.createElement('div'), { className: 'tut-point', innerHTML: '<span></span>' }));
    while (el.children.length > list.length) el.lastElementChild!.remove();
    const w = this.root.clientWidth;
    const h = this.root.clientHeight;
    list.forEach((p, i) => {
      const d = el.children[i] as HTMLElement;
      const span = d.firstElementChild as HTMLElement;
      if (span.textContent !== p.label) span.textContent = p.label;
      const x = Math.max(50, Math.min(w - 50, p.x));
      const y = Math.max(90, Math.min(h - 20, p.y));
      d.style.transform = `translate(${x}px, ${y}px)`;
    });
  }

  /**
   * Keep the card under the top bar (which can wrap) and the toasts under the card,
   * and keep the selection panel off the card so the instructions always show.
   * A panel down the left side pushes the card right; a panel across the bottom
   * (upright phones) gets shorter instead.
   */
  private placeTut(): void {
    const card = this.tutEl;
    if (card.hidden) return;
    const root = this.root.getBoundingClientRect();
    const top = this.top.getBoundingClientRect().bottom - root.top + 6;
    card.style.top = `${top}px`;
    card.style.left = card.style.width = '';
    this.panel.style.maxHeight = '';
    if (!this.panel.hidden && this.panel.offsetWidth) {
      const w = this.root.clientWidth;
      const p = this.panel.getBoundingClientRect();
      if (p.width < w * 0.6) {
        // offsetWidth ignores the pop animation's scale.
        const right = p.right - root.left + 8;
        if ((w - card.offsetWidth) / 2 < right) {
          const log = this.logEl.offsetWidth ? this.logEl.getBoundingClientRect().left - root.left - 8 : w - 8;
          const width = Math.min(440, log - right);
          card.style.width = `${width}px`;
          card.style.left = `${right + (log - right) / 2}px`;
        }
      } else {
        // Leave a strip of map between them for the step's target; the panel scrolls.
        const below = top + card.offsetHeight + 8 + MAP_ROOM;
        if (p.top - root.top < below) this.panel.style.maxHeight = `${Math.max(120, p.bottom - root.top - below)}px`;
      }
    }
    this.toasts.style.top = `${top + card.offsetHeight + 6}px`;
    this.toasts.style.left = card.style.left;
    this.toasts.style.width = card.style.width;
  }

  tutorialDone(d: TutDone): void {
    this.endShown = true;
    this.tutorial(null);
    this.endEl.hidden = false;
    const nextBtn = d.next
      ? `<button data-next class="good">Next: ${d.next.icon} ${esc(d.next.title)}</button>`
      : `<button data-play class="good">🎉 Play a real game</button>`;
    this.endEl.innerHTML = `<div class="endbar" hidden>
      <span>✅ ${esc(d.title)}</span>
      ${d.next ? '<button data-next class="good">Next ▶</button>' : '<button data-play class="good">Play</button>'}
      <button data-list>📋 Tutorials</button><button data-back>Show</button>
    </div>
    <div class="card tut-done">
      <div class="big">${d.icon}</div>
      <h2>✅ ${esc(d.title)}: done!</h2>
      <p>${esc(d.outro)}</p>
      <div class="acts">${nextBtn}<button data-list>📋 All tutorials</button><button data-stay>Keep playing</button></div>
    </div>`;
    const card = this.endEl.querySelector<HTMLElement>('.card')!;
    const bar = this.endEl.querySelector<HTMLElement>('.endbar')!;
    const showCard = (on: boolean): void => {
      card.hidden = !on;
      bar.hidden = on;
      this.endEl.classList.toggle('looking', !on);
    };
    const on = (sel: string, fn: () => void): void => this.endEl.querySelectorAll(sel).forEach((b) => b.addEventListener('click', fn));
    on('[data-next]', () => d.onNext());
    on('[data-play]', () => d.onPlay());
    on('[data-list]', () => d.onList());
    on('[data-stay]', () => showCard(false));
    on('[data-back]', () => showCard(true));
  }

  hint(text: string | null, sub = ''): void {
    this.hintEl.hidden = !text;
    const html = text ? esc(text) + (sub ? `<small>${esc(sub)}</small>` : '') : '';
    if (html !== this.hintHtml) {
      this.hintEl.innerHTML = html;
      this.hintHtml = html;
    }
    this.placeHint();
  }

  /** Lift the hint above the selection panel when they would overlap (narrow screens). */
  private placeHint(): void {
    this.hintEl.style.bottom = '';
    if (this.hintEl.hidden || this.panel.hidden) return;
    const p = this.panel.getBoundingClientRect();
    const h = this.hintEl.getBoundingClientRect();
    const overlapX = h.left < p.right && h.right > p.left;
    const overlapY = h.top < p.bottom && h.bottom > p.top;
    if (overlapX && overlapY) this.hintEl.style.bottom = `${window.innerHeight - p.top + 8}px`;
  }

  drawMinimap(w: World, view: { x0: number; y0: number; x1: number; y1: number }): void {
    if (!this.mode.minimap) return;
    const c = this.mini;
    const W = 200;
    const H = Math.round((W * w.h) / w.w);
    if (c.width !== W * 2) {
      c.width = W * 2;
      c.height = H * 2;
      c.style.width = `${W}px`;
      c.style.height = `${H}px`;
    }
    const g = c.getContext('2d')!;
    const sx = c.width / w.w;
    const sy = c.height / w.h;
    g.fillStyle = '#cdeaa8';
    g.fillRect(0, 0, c.width, c.height);
    for (const b of w.buildings) {
      g.fillStyle = hex(w.factions[b.faction].color) + '33';
      g.beginPath();
      g.arc(b.x * sx, b.y * sy, w.territoryRadius(b.faction) * sx, 0, Math.PI * 2);
      g.fill();
    }
    for (const b of w.blobs) {
      g.fillStyle = b.heat > 0 ? '#ff3b3b' : hex(w.factions[b.faction].color);
      g.fillRect(b.x * sx - 2, b.y * sy - 2, 4, 4);
    }
    g.strokeStyle = '#ffffff';
    g.lineWidth = 2;
    g.strokeRect(view.x0 * sx, view.y0 * sy, (view.x1 - view.x0) * sx, (view.y1 - view.y0) * sy);
  }

  showEnd(w: World): void {
    if (this.endShown || !w.outcome) return;
    this.endShown = true;
    const win = w.outcome.winner === PLAYER;
    const st = w.factions[PLAYER].stats;
    const mins = Math.floor(w.time / 60);
    const secs = Math.floor(w.time % 60).toString().padStart(2, '0');
    this.endEl.hidden = false;
    this.endEl.innerHTML = `<div class="endbar" hidden>
      <span>${win ? '🎉 You won!' : '🥲 Game over'}</span>
      <button data-results>📊 Results</button><button data-restart class="good">Play again</button><button data-menu>Menu</button>
    </div>
    <div class="card">
      <div class="big">${win ? '🎉' : '🥲'}</div>
      <h2>${win ? 'Your blobs united the world!' : 'Another team took over'}</h2>
      <p>${esc(w.outcome.reason)}</p>
      <div class="grid">
        <span>💗 Befriended</span><b>${st.converted}</b>
        <span>🐣 Born</span><b>${st.births}</b>
        <span>💔 Lost</span><b>${st.lost}</b>
        <span>💥 Attacks</span><b>${st.attacks}</b>
        <span>🔒 Jailed</span><b>${st.jailed}</b>
        <span>⏱️ Time</span><b>${mins}:${secs}</b>
      </div>
      <div class="acts"><button data-look>🗺️ Look around</button><button data-restart class="good">Play again</button><button data-menu>Menu</button></div>
    </div>`;
    const card = this.endEl.querySelector<HTMLElement>('.card')!;
    const bar = this.endEl.querySelector<HTMLElement>('.endbar')!;
    const showCard = (on: boolean): void => {
      card.hidden = !on;
      bar.hidden = on;
      this.endEl.classList.toggle('looking', !on);
    };
    this.endEl.querySelectorAll('[data-restart]').forEach((b) => b.addEventListener('click', () => this.h.restart()));
    this.endEl.querySelectorAll('[data-menu]').forEach((b) => b.addEventListener('click', () => this.h.menu()));
    this.endEl.querySelector('[data-look]')!.addEventListener('click', () => showCard(false));
    this.endEl.querySelector('[data-results]')!.addEventListener('click', () => showCard(true));
  }
}

interface PanelOut {
  key: string;
  html: string;
  vals: Record<string, string>;
  widths: Record<string, number>;
}

function meter(label: string, k: string, title = ''): string {
  return `<div class="meter" title="${title}"><span>${label}</span><i class="bar"><i data-w="${k}"></i></i></div>`;
}

function fill(root: HTMLElement, vals: Record<string, string>, widths: Record<string, number>): void {
  for (const el of root.querySelectorAll<HTMLElement>('[data-v]')) {
    const v = vals[el.dataset.v!];
    if (v !== undefined && el.textContent !== v) el.textContent = v;
  }
  for (const el of root.querySelectorAll<HTMLElement>('[data-w]')) {
    const v = widths[el.dataset.w!];
    if (v !== undefined) el.style.width = `${Math.max(0, Math.min(1, v)) * 100}%`;
  }
}

function orderText(w: World, b: Blob): string {
  const o = b.order;
  const name = (id: number): string => w.byId.get(id)?.name ?? '?';
  switch (o.kind) {
    case 'befriend':
      return `befriending ${name(o.target)}`;
    case 'teach':
      return `teaching ${name(o.target)} 📚`;
    case 'usurp':
      return 'taking over a building 🏳️';
    case 'attack':
      return `attacking ${name(o.target)}`;
    case 'chase':
      return `chasing ${name(o.target)}`;
    case 'flee':
      return 'running away';
    case 'move':
      return 'walking';
    default:
      if (b.area) return 'befriending the crowd';
      if (b.job === 'teacher') return 'looking for students';
      if (b.job === 'recruiter') return 'looking for strangers';
      return b.faction === NEUTRAL ? 'wandering' : 'chilling';
  }
}
