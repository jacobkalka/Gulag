import type { MapDef } from '@/game/world/mapTypes';
import type { CollisionWorld } from '@/game/world/collision';
import type { MatchRules } from '@/data/playlists';
import type { Loadout } from '@/data/progression';
import type { GameEvent, GrenadeState, PlayerInput, PlayerState, RoundState } from '@/game/sim/types';

/** Interpolated pose for rendering. */
export interface RenderPose {
  x: number;
  y: number;
  z: number;
  yaw: number;
  pitch: number;
  crouch: number;
}

/**
 * What the match view needs from a session, whether it is the host (authoritative sim),
 * a solo bot match, or a network client (prediction + interpolation).
 */
export interface MatchSession {
  readonly localId: number;
  readonly map: MapDef;
  readonly rules: MatchRules;
  readonly world: CollisionWorld;
  readonly playlistId: string;
  /** Identifier of this match (match records / XP claims). */
  readonly matchId?: string;
  /** All players. For the local player this is the predicted/authoritative state. */
  readonly players: PlayerState[];
  readonly round: RoundState;
  readonly grenades: GrenadeState[];
  /** Fixed-step simulation tick of the newest state. */
  readonly tick: number;
  /** Advances the session by real time `dt`; returns game events produced/received. */
  update(dt: number, sampleInput: () => PlayerInput): GameEvent[];
  /** Interpolated pose for rendering (remote players lag ~100 ms on clients). */
  renderPose(id: number, out: RenderPose): boolean;
  /** Fractional host tick at which remote players are being rendered (for lag compensation). */
  viewTick(): number;
  setLoadout(l: Loadout): void;
  /** Declares the local player's input mode (touchpad tuning is applied by the host). */
  setTouchpad(on: boolean): void;
  /** Round-trip time in ms (0 for local). */
  ping(): number;
  /** Network round trip of any player (scoreboard), when known. */
  pingOf?(id: number): number;
  /** Connection problems to surface in the HUD. */
  status(): { connected: boolean; message: string };
  leave(): void;
}

export function findPlayer(s: MatchSession, id: number): PlayerState | undefined {
  return s.players.find((p) => p.id === id);
}
