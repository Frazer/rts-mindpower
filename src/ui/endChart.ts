import { HISTORY_FIELDS, type World } from '../sim/world';

/** Charts on the end card: how every team did over the game. */

type Metric = 'blobs' | 'income' | 'buildings' | 'tech';

const METRICS: Record<Metric, { icon: string; label: string; sub: string; wild: boolean }> = {
  blobs: { icon: '👥', label: 'Blobs', sub: 'Blobs on each team', wild: true },
  income: { icon: '🪙', label: 'Income', sub: 'Gold earned per minute', wild: false },
  buildings: { icon: '🏠', label: 'Buildings', sub: 'Building levels (a level 3 market counts 3)', wild: false },
  tech: { icon: '🔬', label: 'Tech', sub: 'Tech level', wild: false },
};
const ORDER: Metric[] = ['blobs', 'income', 'buildings', 'tech'];

interface Series {
  id: number;
  name: string;
  color: string;
  values: number[];
  mine: boolean;
}

const H = 190;
const PAD = { top: 12, right: 34, bottom: 22, left: 34 };
const INK = '#3b2633';
const MUTED = '#7a6470';
const GRID = 'rgba(59, 38, 51, 0.12)';
const SURFACE = '#fffcf7';
const SVG = 'http://www.w3.org/2000/svg';

const hex = (c: number): string => `#${c.toString(16).padStart(6, '0')}`;
const clock = (t: number): string => `${Math.floor(t / 60)}:${Math.floor(t % 60).toString().padStart(2, '0')}`;
const fmt = (v: number): string => (v >= 10_000 ? `${Math.round(v / 1000)}K` : Math.round(v).toLocaleString('en-US'));

/** Gridline spacing: 1, 2 or 5 times a power of ten, about four steps to the top. */
function niceStep(max: number, whole: boolean): number {
  const raw = Math.max(max, 1e-9) / 4;
  const p = 10 ** Math.floor(Math.log10(raw));
  const step = ([1, 2, 5, 10].find((m) => m * p >= raw) ?? 10) * p;
  return whole ? Math.max(1, Math.round(step)) : step;
}

function seriesFor(w: World, me: number, metric: Metric): { times: number[]; series: Series[] } {
  const rows = w.history.rows;
  const times = rows.map((r) => r[0]);
  const at = (r: number[], team: number, k: number): number => r[1 + team * HISTORY_FIELDS + k] ?? 0;
  const series = w.factions
    .filter((f) => METRICS[metric].wild || !f.isNeutral)
    .map((f) => {
      const values =
        metric === 'income'
          ? rows.map((_, j) => {
              // A rate needs two rows: the first point borrows the second's.
              const k = Math.max(1, j);
              const a = rows[k - 1];
              const b = rows[k];
              const dt = b ? b[0] - a[0] : 0;
              return dt > 0 ? Math.max(0, ((at(b, f.id, 1) - at(a, f.id, 1)) / dt) * 60) : 0;
            })
          : rows.map((r) => at(r, f.id, metric === 'blobs' ? 0 : metric === 'buildings' ? 2 : 3));
      return { id: f.id, name: f.isNeutral ? 'Wanderers' : f.id === me ? `${f.name} (you)` : f.name, color: hex(f.color), values, mine: f.id === me };
    });
  return { times, series };
}

function el<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number>, parent?: Element): SVGElementTagNameMap[K] {
  const e = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  parent?.append(e);
  return e;
}

/** Fill `root` with the chart tabs, the chart and its legend. */
export function endCharts(root: HTMLElement, w: World, me: number): void {
  if (w.history.rows.length < 2) {
    root.innerHTML = '<p class="note dim">The game was too short to chart.</p>';
    return;
  }
  root.innerHTML = `<div class="chart-tabs seg">${ORDER.map(
    (m) => `<button data-metric="${m}">${METRICS[m].icon} ${METRICS[m].label}</button>`,
  ).join('')}</div>
    <p class="chart-sub"></p>
    <div class="chart-wrap"><svg></svg><div class="chart-tip" hidden></div></div>
    <div class="chart-legend"></div>`;
  const tabs = [...root.querySelectorAll<HTMLButtonElement>('[data-metric]')];
  const sub = root.querySelector<HTMLElement>('.chart-sub')!;
  const wrap = root.querySelector<HTMLElement>('.chart-wrap')!;
  const svg = root.querySelector<SVGSVGElement>('svg')!;
  const tip = root.querySelector<HTMLElement>('.chart-tip')!;
  const legend = root.querySelector<HTMLElement>('.chart-legend')!;

  let metric: Metric = 'blobs';
  /** Team picked in the legend: the others fade. */
  let focus: number | null = null;
  let data = seriesFor(w, me, metric);
  let geo = { x: (_t: number) => 0, y: (_v: number) => 0, w: 0 };
  let cross: SVGGElement | null = null;

  const draw = (): void => {
    const width = Math.max(240, wrap.clientWidth);
    const { times, series } = data;
    const t0 = times[0];
    const t1 = times.at(-1)!;
    let top = 0;
    for (const s of series) for (const v of s.values) top = Math.max(top, v);
    const step = niceStep(top, metric !== 'income');
    const yMax = Math.max(step, Math.ceil(top / step - 1e-9) * step);
    const plotW = width - PAD.left - PAD.right;
    const plotH = H - PAD.top - PAD.bottom;
    const x = (t: number): number => PAD.left + ((t - t0) / Math.max(1e-9, t1 - t0)) * plotW;
    const y = (v: number): number => PAD.top + plotH - (v / yMax) * plotH;
    geo = { x, y, w: width };

    svg.replaceChildren();
    svg.setAttribute('viewBox', `0 0 ${width} ${H}`);
    svg.setAttribute('width', `${width}`);
    svg.setAttribute('height', `${H}`);
    svg.setAttribute('role', 'img');
    const finals = series.map((s) => `${s.name} ${fmt(s.values.at(-1)!)}`).join(', ');
    svg.setAttribute('aria-label', `${METRICS[metric].sub} over ${clock(t1)}. At the end: ${finals}.`);

    // Gridlines and their numbers.
    for (let v = 0; v <= yMax + 1e-9; v += step) {
      el('line', { x1: PAD.left, x2: width - PAD.right, y1: y(v), y2: y(v), stroke: GRID, 'stroke-width': 1 }, svg);
      const label = el('text', { x: PAD.left - 6, y: y(v) + 4, 'text-anchor': 'end', fill: MUTED, 'font-size': 11 }, svg);
      label.textContent = fmt(v);
    }
    const ticks = t1 - t0 >= 120 ? [t0, (t0 + t1) / 2, t1] : [t0, t1];
    ticks.forEach((t, i) => {
      const anchor = i === 0 ? 'start' : i === ticks.length - 1 ? 'end' : 'middle';
      const label = el('text', { x: x(t), y: H - 6, 'text-anchor': anchor, fill: MUTED, 'font-size': 11 }, svg);
      label.textContent = clock(t);
    });

    // Lines: the picked team (or yours) on top.
    const rank = (s: Series): number => (focus === null ? (s.mine ? 1 : 0) : s.id === focus ? 1 : 0);
    const ordered = [...series].sort((a, b) => rank(a) - rank(b));
    for (const s of ordered) {
      const faded = focus !== null && s.id !== focus;
      const g = el('g', { opacity: faded ? 0.18 : 1 }, svg);
      const d = s.values.map((v, i) => `${i ? 'L' : 'M'}${x(times[i]).toFixed(1)},${y(v).toFixed(1)}`).join('');
      el('path', { d, fill: 'none', stroke: s.color, 'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }, g);
      const ex = x(t1);
      const ey = y(s.values.at(-1)!);
      el('circle', { cx: ex, cy: ey, r: 4, fill: s.color, stroke: SURFACE, 'stroke-width': 2 }, g);
      if (s.mine && (focus === null || focus === s.id)) {
        const label = el('text', { x: ex + 8, y: ey + 4, fill: INK, 'font-size': 11, 'font-weight': 700 }, g);
        label.textContent = 'You';
      }
    }
    cross = el('g', { visibility: 'hidden', 'pointer-events': 'none' }, svg);
  };

  const legendHtml = (): void => {
    legend.replaceChildren(
      ...[...data.series]
        .sort((a, b) => b.values.at(-1)! - a.values.at(-1)!)
        .map((s) => {
          const b = document.createElement('button');
          b.className = focus === s.id ? 'on' : focus !== null ? 'dim' : '';
          b.title = focus === s.id ? 'Show every team' : 'Pick out this team';
          const key = document.createElement('i');
          key.style.background = s.color;
          const name = document.createElement('span');
          name.textContent = s.name;
          const val = document.createElement('b');
          val.textContent = fmt(s.values.at(-1)!);
          b.append(key, name, val);
          b.addEventListener('click', () => {
            focus = focus === s.id ? null : s.id;
            draw();
            legendHtml();
          });
          return b;
        }),
    );
  };

  const show = (m: Metric): void => {
    metric = m;
    data = seriesFor(w, me, m);
    for (const t of tabs) t.classList.toggle('on', t.dataset.metric === m);
    sub.textContent = METRICS[m].sub;
    tip.hidden = true;
    draw();
    legendHtml();
  };

  /** The readout: every team's value at the time nearest the pointer. */
  const point = (e: PointerEvent): void => {
    if (!cross) return;
    const box = svg.getBoundingClientRect();
    const px = ((e.clientX - box.left) / box.width) * geo.w;
    const { times, series } = data;
    let i = 0;
    for (let j = 1; j < times.length; j++) if (Math.abs(geo.x(times[j]) - px) < Math.abs(geo.x(times[i]) - px)) i = j;
    const cx = geo.x(times[i]);
    cross.replaceChildren();
    cross.setAttribute('visibility', 'visible');
    el('line', { x1: cx, x2: cx, y1: PAD.top, y2: H - PAD.bottom, stroke: INK, 'stroke-opacity': 0.35, 'stroke-width': 1 }, cross);
    for (const s of series) {
      if (focus !== null && s.id !== focus) continue;
      el('circle', { cx, cy: geo.y(s.values[i]), r: 4, fill: s.color, stroke: SURFACE, 'stroke-width': 2 }, cross);
    }
    const head = document.createElement('div');
    head.className = 'when';
    head.textContent = clock(times[i]);
    const rows = [...series]
      .filter((s) => focus === null || s.id === focus)
      .sort((a, b) => b.values[i] - a.values[i])
      .map((s) => {
        const row = document.createElement('div');
        const key = document.createElement('i');
        key.style.background = s.color;
        const val = document.createElement('b');
        val.textContent = fmt(s.values[i]);
        const name = document.createElement('span');
        name.textContent = s.name;
        row.append(key, val, name);
        return row;
      });
    tip.replaceChildren(head, ...rows);
    tip.hidden = false;
    // Beside the line, on whichever side has room.
    const scale = box.width / geo.w;
    const left = cx * scale;
    const tw = tip.offsetWidth;
    tip.style.left = `${left + 12 + tw > wrap.clientWidth ? Math.max(0, left - 12 - tw) : left + 12}px`;
  };
  const hide = (): void => {
    tip.hidden = true;
    cross?.setAttribute('visibility', 'hidden');
  };
  svg.addEventListener('pointermove', point);
  svg.addEventListener('pointerdown', point);
  svg.addEventListener('pointerleave', hide);
  for (const t of tabs) t.addEventListener('click', () => show(t.dataset.metric as Metric));

  new ResizeObserver(() => {
    if (wrap.isConnected && wrap.clientWidth > 0) draw();
  }).observe(wrap);
  show('blobs');
}
