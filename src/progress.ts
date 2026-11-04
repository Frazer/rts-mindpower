import type { ModeId } from './modes';

/** Which tutorial levels you've finished, per mode. Saved in this browser only. */
export type TutorialProgress = Record<ModeId, string[]>;

const KEY = 'mindblobs.tutorials.v1';

function read(): TutorialProgress {
  const empty: TutorialProgress = { casual: [], pro: [] };
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return empty;
    const p = JSON.parse(raw) as Partial<Record<ModeId, unknown>>;
    const list = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
    return { casual: list(p.casual), pro: list(p.pro) };
  } catch {
    // Storage blocked (private window, site data off) or junk saved: start fresh.
    return empty;
  }
}

// Kept in memory too, so progress still works this session when storage is blocked.
let cache: TutorialProgress = read();

function save(): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(cache));
  } catch {
    // Can't save; the in-memory copy still counts for this visit.
  }
}

export function completed(mode: ModeId): ReadonlySet<string> {
  return new Set(cache[mode]);
}

export function markCompleted(mode: ModeId, id: string): void {
  if (cache[mode].includes(id)) return;
  cache = { ...cache, [mode]: [...cache[mode], id] };
  save();
}

export function resetProgress(mode: ModeId): void {
  cache = { ...cache, [mode]: [] };
  save();
}
