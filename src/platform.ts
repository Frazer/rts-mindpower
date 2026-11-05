/**
 * One small interface over the game portals' SDKs (CrazyGames, Poki), so the game
 * code never talks to a portal directly. The plain web build (itch.io, GitHub Pages,
 * your own site) uses the 'web' version, where every call does nothing and there are no ads.
 *
 * Pick the portal at build time: `vite build --mode crazygames` / `--mode poki`.
 * In dev, `?platform=crazygames` or `?platform=poki` tries one out.
 */

export type PlatformId = 'web' | 'crazygames' | 'poki';

/**
 * Where an ad break is: 'waiting' from the request until an ad starts (game paused, input blocked,
 * sound still on), 'playing' while it shows (also silent), 'idle' otherwise.
 */
export type AdState = 'idle' | 'waiting' | 'playing';

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
  /** False once the portal says ads are off for this session (e.g. CrazyGames Basic Launch). */
  adsAvailable(): boolean;
  /** Go silent as soon as an ad is asked for, instead of when it starts (for SDKs whose start callback can be skipped). */
  muteOnRequest: boolean;
  /** Whether the portal allows a rewarded-ad button on the screen while you play. */
  rewardedInPlay: boolean;
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
  adsAvailable: () => false,
  muteOnRequest: false,
  rewardedInPlay: false,
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
  adError(e: { code?: string; message?: string } | undefined): void;
}
interface CrazySdk {
  init(): Promise<void>;
  environment: 'local' | 'crazygames' | 'disabled';
  game: { gameplayStart(): void; gameplayStop(): void; loadingStart(): void; loadingStop(): void; happytime(): void };
  ad: { requestAd(type: 'midgame' | 'rewarded', cb: CrazyAdCallbacks): void };
  data: KeyValue;
}
const crazy = (): CrazySdk => (window as unknown as { CrazyGames: { SDK: CrazySdk } }).CrazyGames.SDK;

/** Set when CrazyGames answers 'adsDisabled' (Basic Launch, Kids mode, offline): don't ask again this session. */
let crazyAdsOff = false;
function crazyAd(type: 'midgame' | 'rewarded', started: () => void): Promise<boolean> {
  return new Promise((resolve) =>
    crazy().ad.requestAd(type, {
      adStarted: started,
      adFinished: () => resolve(true),
      adError: (e) => {
        if (e?.code === 'adsDisabled') crazyAdsOff = true;
        resolve(false);
      },
    }),
  );
}

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
  midgameAd: async (started) => void (await crazyAd('midgame', started)),
  rewardedAd: (started) => crazyAd('rewarded', started),
  storage: () => crazy().data,
  adsAvailable: () => !crazyAdsOff,
  // CrazyGames: "Only mute the audio when the ad actually starts playing, and not when you request an ad."
  muteOnRequest: false,
  // CrazyGames: "The request button should not appear on an active gameplay screen."
  rewardedInPlay: false,
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
  midgameAd: (started) => poki().commercialBreak(started),
  rewardedAd: (started) => poki().rewardedBreak(started),
  storage: () => null,
  adsAvailable: () => true,
  // Poki may not call onStart for every ad, so go quiet as soon as we ask.
  muteOnRequest: true,
  rewardedInPlay: true,
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
  private adListener: (state: AdState) => void = () => {};
  /** Where saves go: the portal's cloud save when it has one, else this browser. */
  storage: KeyValue = local;

  /** True when a portal SDK has loaded and hasn't said ads are off for this session. */
  get ads(): boolean {
    return this.sdk.adsAvailable();
  }

  /** Whether to offer the rewarded-ad button during play (only where the portal allows it). */
  get rewardedInPlay(): boolean {
    return this.ads && this.sdk.rewardedInPlay;
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

  /** Told when an ad break is requested, starts and ends: pause and block input unless 'idle', and go silent while 'playing'. */
  onAd(fn: (state: AdState) => void): void {
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
   * The game is paused and input blocked for the whole request (portals ask for the UI to wait until
   * the ad finishes or fails). Sound goes off when the ad starts, or at once where the start callback
   * can be skipped (Poki).
   */
  private async ad<T>(show: (started: () => void) => Promise<T>): Promise<T | undefined> {
    if (!this.ads || this.inAd) return undefined;
    this.setPlaying(false);
    this.inAd = true;
    const muteNow = this.sdk.muteOnRequest;
    this.adListener(muteNow ? 'playing' : 'waiting');
    try {
      return await show(() => {
        if (!muteNow && this.inAd) this.adListener('playing');
      });
    } catch (e) {
      console.warn('[platform] ad failed:', e);
      return undefined;
    } finally {
      this.inAd = false;
      this.adListener('idle');
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
