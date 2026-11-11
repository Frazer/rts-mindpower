export type ModeId = 'casual' | 'pro';

/** One simulation, two tunings. Casual = relaxed mobile; Pro = fast, deep PC. */
export interface ModeConfig {
  id: ModeId;
  label: string;
  worldW: number;
  worldH: number;
  blobsPerFaction: number;
  neutrals: number;
  defaultSpeed: number;
  speeds: readonly number[];
  /** Seconds between AI decisions. */
  aiThink: number;
  /** Seconds at the start before computer teams send anyone out (they still build). */
  aiGrace: number;
  aiAggression: number;
  conversionMult: number;
  /** How many blob-years pass per game second (blobs live about 100 years). */
  yearsPerSecond: number;
  startGold: number;
  incomeMult: number;
  /** Fraction of all blobs you must lead to win. */
  winShare: number;
  showNumbers: boolean;
  boxSelect: boolean;
  hotkeys: boolean;
  minimap: boolean;
  eventLog: boolean;
}

export const MODES: Record<ModeId, ModeConfig> = {
  casual: {
    id: 'casual',
    label: 'Casual',
    worldW: 1800,
    worldH: 1500,
    blobsPerFaction: 8,
    neutrals: 26,
    defaultSpeed: 1,
    speeds: [1, 2],
    aiThink: 9,
    aiGrace: 60,
    aiAggression: 0.4,
    conversionMult: 1.3,
    yearsPerSecond: 0.07,
    startGold: 120,
    incomeMult: 1.3,
    winShare: 0.9,
    showNumbers: false,
    boxSelect: false,
    hotkeys: false,
    minimap: false,
    eventLog: false,
  },
  pro: {
    id: 'pro',
    label: 'Pro',
    worldW: 2800,
    worldH: 2200,
    blobsPerFaction: 10,
    neutrals: 50,
    defaultSpeed: 1.5,
    speeds: [1, 1.5, 2, 3],
    aiThink: 3,
    aiGrace: 0,
    aiAggression: 1,
    conversionMult: 1,
    yearsPerSecond: 0.1,
    startGold: 100,
    incomeMult: 1,
    winShare: 0.9,
    showNumbers: true,
    boxSelect: true,
    hotkeys: true,
    minimap: true,
    eventLog: true,
  },
};
