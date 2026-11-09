import { MAPS, MAP_IDS, SIZES, SIZE_IDS, type MapId, type MapSize } from '../sim/maps';

const esc = (s: string): string => s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);

/** Map layout buttons and a size switch; `on` marks the current ones. */
export function mapPicker(map: MapId, size: MapSize, enabled = true): string {
  const maps = MAP_IDS.map(
    (id) =>
      `<button data-map="${id}" class="${id === map ? 'on' : ''}" title="${esc(MAPS[id].desc)}" ${enabled ? '' : 'disabled'}><span>${MAPS[id].icon}</span>${esc(MAPS[id].label)}</button>`,
  ).join('');
  const sizes = SIZE_IDS.map(
    (id) => `<button data-size="${id}" class="${id === size ? 'on' : ''}" ${enabled ? '' : 'disabled'}>${SIZES[id].label}</button>`,
  ).join('');
  return `<div class="map-pick"><div class="maps">${maps}</div><div class="seg sizes" role="group" aria-label="Map size">${sizes}</div>
    <p class="map-desc">${esc(MAPS[map].desc)}</p></div>`;
}
