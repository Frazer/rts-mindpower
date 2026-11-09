/** Map choices: a layout (what's on the ground) and a size. */

export type MapId = 'meadow' | 'lakes' | 'woods' | 'crowd';
export type MapSize = 'small' | 'medium' | 'large';

export interface MapDef {
  label: string;
  icon: string;
  desc: string;
}

export const MAPS: Record<MapId, MapDef> = {
  meadow: { label: 'Meadow', icon: '🌼', desc: 'Open grass, wanderer camps all around' },
  lakes: { label: 'Lakes', icon: '🏞️', desc: 'Big ponds to walk around and build beside' },
  woods: { label: 'Woods', icon: '🌲', desc: 'Clumps of trees and rocks make little paths' },
  crowd: { label: 'Crowded Middle', icon: '🎪', desc: 'Lots of wanderers packed in the middle' },
};
export const MAP_IDS = Object.keys(MAPS) as MapId[];

export const SIZES: Record<MapSize, { label: string; area: number }> = {
  small: { label: 'Small', area: 0.6 },
  medium: { label: 'Medium', area: 1 },
  large: { label: 'Large', area: 1.6 },
};
export const SIZE_IDS = Object.keys(SIZES) as MapSize[];

export const isMapId = (v: unknown): v is MapId => typeof v === 'string' && v in MAPS;
export const isMapSize = (v: unknown): v is MapSize => typeof v === 'string' && v in SIZES;

/** Something blobs walk around and nobody can build on. */
export interface Obstacle {
  x: number;
  y: number;
  r: number;
  kind: 'pond' | 'rock' | 'trees';
}

/** How close a blob's centre may come to an obstacle's edge. */
export const OBSTACLE_PAD = 10;
