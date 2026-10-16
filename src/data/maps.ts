// What the lobby shows for each map (without building it), and the "Random" choice.
// The builders live in game/world/maps.ts; ids must match MAP_BUILDERS there.

export type MapId = 'sublevel9' | 'monsoon';
export type MapChoice = MapId | 'random';

export interface MapInfo {
  id: MapId;
  name: string;
  /** One line for the map card. */
  blurb: string;
  /** Preview image under public/ (relative to the site base). */
  thumb: string;
}

export const MAP_INFO: Record<MapId, MapInfo> = {
  sublevel9: {
    id: 'sublevel9',
    name: 'Sublevel 9',
    blurb: 'A flooded prison bunker on three levels: cell blocks, catwalks, a boiler hall and the cistern below.',
    thumb: 'maps/sublevel9.jpg',
  },
  monsoon: {
    id: 'monsoon',
    name: 'Monsoon',
    blurb: 'A jungle outpost at night in a downpour: the helipad, swamp boardwalks, the ridge and the river.',
    thumb: 'maps/monsoon.jpg',
  },
};

export const MAP_ORDER: MapId[] = ['sublevel9', 'monsoon'];

export function isMapChoice(v: unknown): v is MapChoice {
  return v === 'random' || (typeof v === 'string' && v in MAP_INFO);
}

/** A concrete map for a choice; Random picks from a seed so everyone who knows it agrees. */
export function resolveMapChoice(choice: MapChoice, seed: number): MapId {
  if (choice !== 'random') return choice;
  return MAP_ORDER[(seed >>> 0) % MAP_ORDER.length];
}

/** Display name for a choice ("Random" included). */
export function mapChoiceName(choice: MapChoice): string {
  return choice === 'random' ? 'Random' : MAP_INFO[choice].name;
}

/** A matchmade room's map: one of the players' picks (weighted by party size), else Random. */
export function pickMatchMap(tickets: { size: number; map?: string }[], rand: number): MapChoice {
  const picks = tickets.filter((t) => isMapChoice(t.map) && t.map !== 'random');
  const total = picks.reduce((a, t) => a + t.size, 0);
  if (!total) return 'random';
  let r = rand * total;
  for (const t of picks) {
    r -= t.size;
    if (r < 0) return t.map as MapChoice;
  }
  return picks[picks.length - 1].map as MapChoice;
}
