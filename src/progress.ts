import type { ModeId } from './modes';
import { platform } from './platform';

/** Which tutorial levels you've finished, per mode. Saved in the portal's cloud save, or this browser. */
export type TutorialProgress = Record<ModeId, string[]>;

const KEY = 'mindblobs.tutorials.v1';

function read(): TutorialProgress {
  const empty: TutorialProgress = { casual: [], pro: [] };
  try {
    const raw = platform.storage.getItem(KEY);
    if (!raw) return empty;
    const p = JSON.parse(raw) as Partial<Record<ModeId, unknown>>;
    const list = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
    return { casual: list(p.casual), pro: list(p.pro) };
  } catch {
    // Junk saved: start fresh.
    return empty;
  }
}

// Kept in memory too, so progress still works this session when storage is blocked.
// Read on first use, after the portal SDK (and its cloud save) has started.
let cache: TutorialProgress | null = null;
const get = (): TutorialProgress => (cache ??= read());

function save(): void {
  platform.storage.setItem(KEY, JSON.stringify(get()));
}

export function completed(mode: ModeId): ReadonlySet<string> {
  return new Set(get()[mode]);
}

export function markCompleted(mode: ModeId, id: string): void {
  const c = get();
  if (c[mode].includes(id)) return;
  cache = { ...c, [mode]: [...c[mode], id] };
  save();
}

export function resetProgress(mode: ModeId): void {
  cache = { ...get(), [mode]: [] };
  save();
}
