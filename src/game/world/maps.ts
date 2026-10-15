import type { MapDef } from './mapTypes';
import { buildSublevel9 } from './sublevel9';
import { buildMonsoon } from './monsoon';

// All maps by id. Builders are pure and deterministic: host and clients build identical data.

export const MAP_BUILDERS: Record<string, () => MapDef> = {
  sublevel9: buildSublevel9,
  monsoon: buildMonsoon,
};

export const MAP_IDS = Object.keys(MAP_BUILDERS);

export function buildMap(id: string): MapDef {
  const b = MAP_BUILDERS[id];
  if (!b) throw new Error(`unknown map '${id}'`);
  return b();
}
