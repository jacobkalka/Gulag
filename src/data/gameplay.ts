// Gameplay tuning that isn't per-weapon (weapon stats live in weapons.ts).

/**
 * Health and automatic regeneration. The host applies it in the shared simulation step
 * (`finishPlayerStep`), so it is authoritative in multiplayer; clients only display it.
 */
export const HEALTH = {
  max: 100,
  /** Seconds without taking damage before regeneration starts. Any damage resets the timer. */
  regenDelay: 5,
  /** Seconds to refill from empty to full once regeneration runs at full speed. */
  regenTime: 3.2,
  /** Regeneration eases in over this many seconds so the refill starts smoothly. */
  regenEaseIn: 0.6,
};

/** HP regenerated during one step of `dt` seconds, `sinceHurt` seconds after the last damage. */
export function regenAmount(sinceHurt: number, dt: number): number {
  const t = sinceHurt - HEALTH.regenDelay;
  if (t <= 0) return 0;
  const ease = Math.min(1, t / HEALTH.regenEaseIn);
  return (HEALTH.max / HEALTH.regenTime) * ease * ease * (3 - 2 * ease) * dt;
}
