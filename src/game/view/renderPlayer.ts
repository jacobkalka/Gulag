// What the views need to draw a player: built each frame from the session's interpolated state.

export interface RenderPlayer {
  id: number;
  team: 0 | 1;
  name: string;
  alive: boolean;
  x: number;
  y: number;
  z: number;
  vx: number;
  vz: number;
  yaw: number;
  pitch: number;
  crouch: number;
  slide: boolean;
  grounded: boolean;
  ads: number;
  sprint: boolean;
  weapon: string;
  reloading: boolean;
  hp: number;
  /** Direction (yaw) the killing shot came from, for the death fall. */
  deathYaw: number;
}
