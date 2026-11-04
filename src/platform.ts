/**
 * One small interface over the game portals' SDKs (CrazyGames, Poki), so the game
 * code never talks to a portal directly. The plain web build (itch.io, GitHub Pages,
 * your own site) uses the 'web' version, where every call does nothing and there are no ads.
 *
 * Pick the portal at build time: `vite build --mode crazygames` / `--mode poki`.
 * In dev, `?platform=crazygames` or `?platform=poki` tries one out.
 */

export type PlatformId = 'web' | 'crazygames' | 'poki';

/** Same shape as localStorage, so either can be used for saves. */
export interface KeyValue {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

interface Sdk {
  init(): Promise<void>;
  loadingDone(): void;
  gameplayStart(): void;
  gameplayStop(): void;
  happyTime(): void;
  /** Resolves when the break is over, or straight away if no ad was shown. */
  midgameAd(started: () => void): Promise<void>;
  /** Resolves true when the player watched the whole ad and earned the reward. */
  rewardedAd(started: () => void): Promise<boolean>;
  /** The portal's cloud save, if it has one. */
  storage(): KeyValue | null;
}

/** localStorage, but never throws (private windows, blocked site data, sandboxed iframes). */
const local: KeyValue = {
  getItem(key) {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  setItem(key, value) {
    try {
      localStorage.setItem(key, value);
    } catch {
      // Can't save here; the game keeps working for this visit.
    }
  },
};

const WEB: Sdk = {
  init: async () => {},
  loadingDone: () => {},
  gameplayStart: () => {},
  gameplayStop: () => {},
  happyTime: () => {},
  midgameAd: async () => {},
  rewardedAd: async () => false,
  storage: () => null,
};

function loadScript(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error(`Couldn't load ${src}`));
    document.head.appendChild(s);
  });
}

function timeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  return Promise.race([p, new Promise<T>((resolve) => setTimeout(() => resolve(fallback), ms))]);
}

// ─── CrazyGames (SDK v3) ───

interface CrazyAdCallbacks {
  adStarted(): void;
  adFinished(): void;
  adError(e: unknown): void;
}
interface CrazySdk {
  init(): Promise<void>;
  environment: 'local' | 'crazygames' | 'disabled';
  game: { gameplayStart(): void; gameplayStop(): void; loadingStart(): void; loadingStop(): void; happytime(): void };
  ad: { requestAd(type: 'midgame' | 'rewarded', cb: CrazyAdCallbacks): void };
  data: KeyValue;
}
const crazy = (): CrazySdk => (window as unknown as { CrazyGames: { SDK: CrazySdk } }).CrazyGames.SDK;

const CRAZYGAMES: Sdk = {
  async init() {
    await loadScript('https://sdk.crazygames.com/crazygames-sdk-v3.js');
    await crazy().init();
    if (crazy().environment === 'disabled') throw new Error('CrazyGames SDK is disabled on this site');
    crazy().game.loadingStart();
  },
  loadingDone: () => crazy().game.loadingStop(),
  gameplayStart: () => crazy().game.gameplayStart(),
  gameplayStop: () => crazy().game.gameplayStop(),
  happyTime: () => crazy().game.happytime(),
  midgameAd: (started) =>
    new Promise((resolve) => crazy().ad.requestAd('midgame', { adStarted: started, adFinished: () => resolve(), adError: () => resolve() })),
  rewardedAd: (started) =>
    new Promise((resolve) =>
      crazy().ad.requestAd('rewarded', { adStarted: started, adFinished: () => resolve(true), adError: () => resolve(false) }),
    ),
  storage: () => crazy().data,
};

// ─── Poki (SDK v2) ───

interface PokiSdk {
  init(): Promise<void>;
  gameLoadingFinished(): void;
  gameplayStart(): void;
  gameplayStop(): void;
  commercialBreak(onStart?: () => void): Promise<void>;
  rewardedBreak(onStart?: () => void): Promise<boolean>;
}
const poki = (): PokiSdk => (window as unknown as { PokiSDK: PokiSdk }).PokiSDK;

const POKI: Sdk = {
  async init() {
    await loadScript('https://game-cdn.poki.com/scripts/v2/poki-sdk.js');
    await poki().init();
  },
  loadingDone: () => poki().gameLoadingFinished(),
  gameplayStart: () => poki().gameplayStart(),
  gameplayStop: () => poki().gameplayStop(),
  happyTime: () => {},
  // Poki may not call onStart for every ad, so the game is already stopped before asking.
  midgameAd: (started) => poki().commercialBreak(started),
  rewardedAd: (started) => poki().rewardedBreak(started),
  storage: () => null,
};

/**
 * Written so the build mode is a constant the bundler can fold: each build keeps only its
 * own portal's code. (Portals can reject games that mention another portal's SDK.)
 */
function pickPlatform(): [PlatformId, Sdk] {
  if (import.meta.env.MODE === 'crazygames') return ['crazygames', CRAZYGAMES];
  if (import.meta.env.MODE === 'poki') return ['poki', POKI];
  if (import.meta.env.DEV && typeof location !== 'undefined') {
    const p = new URLSearchParams(location.search).get('platform');
    if (p === 'crazygames') return ['crazygames', CRAZYGAMES];
    if (p === 'poki') return ['poki', POKI];
  }
  return ['web', WEB];
}

const [PICKED_ID, PICKED_SDK] = pickPlatform();

class Platform {
  readonly id: PlatformId = PICKED_ID;
  private sdk: Sdk = WEB;
  private playing = false;
  private inAd = false;
  private adListener: (playing: boolean) => void = () => {};
  /** Where saves go: the portal's cloud save when it has one, else this browser. */
  storage: KeyValue = local;

  /** True once a portal SDK has loaded, so ads (and the rewarded-ad button) are available. */
  get ads(): boolean {
    return this.sdk !== WEB;
  }

  /** Load and start the portal SDK. Never fails: if the SDK is blocked or missing, the game runs without it. */
  async init(): Promise<void> {
    const sdk = PICKED_SDK;
    if (sdk === WEB) return;
    try {
      const ok = await timeout(sdk.init().then(() => true), 8000, false);
      if (!ok) throw new Error('timed out');
      this.sdk = sdk;
      this.storage = sdk.storage() ?? local;
    } catch (e) {
      console.warn(`[platform] ${this.id} SDK not available, playing without it:`, e);
    }
  }

  /** Called with true when an ad starts and false when it ends: mute and pause the game meanwhile. */
  onAd(fn: (playing: boolean) => void): void {
    this.adListener = fn;
  }

  loadingDone(): void {
    this.safe(() => this.sdk.loadingDone());
  }

  /** Tell the portal whether the player is actively playing (not paused, in a menu or watching an ad). */
  setPlaying(on: boolean): void {
    if (on === this.playing || (on && this.inAd)) return;
    this.playing = on;
    this.safe(() => (on ? this.sdk.gameplayStart() : this.sdk.gameplayStop()));
  }

  /** A good moment for the portal to celebrate (level done, game won). */
  happyTime(): void {
    this.safe(() => this.sdk.happyTime());
  }

  /** A natural break (between levels, before another game). The portal decides whether an ad actually shows. */
  async commercialBreak(): Promise<void> {
    await this.ad((started) => timeout(this.sdk.midgameAd(started), 90_000, undefined));
  }

  /** The player chose to watch an ad for a reward. Resolves true if they earned it. */
  async rewardedBreak(): Promise<boolean> {
    return (await this.ad((started) => timeout(this.sdk.rewardedAd(started), 90_000, false))) ?? false;
  }

  /**
   * Pause and mute for the whole request, not just from the SDK's "ad started" callback:
   * Poki says that callback may not always fire, and a request that shows nothing ends at once anyway.
   */
  private async ad<T>(show: (started: () => void) => Promise<T>): Promise<T | undefined> {
    if (!this.ads || this.inAd) return undefined;
    this.setPlaying(false);
    this.inAd = true;
    this.adListener(true);
    try {
      return await show(() => {});
    } catch (e) {
      console.warn('[platform] ad failed:', e);
      return undefined;
    } finally {
      this.inAd = false;
      this.adListener(false);
    }
  }

  private safe(fn: () => void): void {
    try {
      fn();
    } catch (e) {
      console.warn('[platform]', e);
    }
  }
}

export const platform = new Platform();
