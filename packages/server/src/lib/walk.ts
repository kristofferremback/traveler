/**
 * How long a walk takes for this traveller.
 *
 * Flat time at the chosen speed, plus Naismith's allowance for climbing: one minute per
 * ten metres of ascent. Descent is free. The rule is over a century old and still what
 * hikers use; it also reproduces the one calibration point we have -- Jarlaberg to the
 * Nacka strand pier is 982 m flat-walking and a 58 m climb home, which Kris knows to be
 * a 15 minute walk and Valhalla alone calls 9.6.
 *
 * Routing engines do not do this for pedestrians (Valhalla's `use_hills` is a bicycle
 * option), so it lives here, on top of their distance and elevation profile.
 */
export const ASCENT_SECONDS_PER_METRE = 6;

export function walkSeconds(metres: number, ascentMetres: number, speedKmh: number): number {
  if (!(speedKmh > 0)) throw new RangeError("walking speed must be positive");
  const flat = metres / (speedKmh / 3.6);
  const climb = Math.max(0, ascentMetres) * ASCENT_SECONDS_PER_METRE;
  return Math.round(flat + climb);
}

/**
 * The SL journey planner expresses walking as a percentage of its own baseline time.
 * Measured from its leg geometry the baseline is 3.7 km/h (plus a minimum it adds per
 * walk, which we cannot remove). The gateway accepts 25..400.
 */
export const SL_BASELINE_KMH = 3.7;

export function slWalkPercent(speedKmh: number): number {
  const percent = Math.round((SL_BASELINE_KMH / speedKmh) * 100);
  return Math.min(400, Math.max(25, percent));
}

/** Total climb and descent along an elevation profile sampled at regular intervals. */
export function ascentDescent(profile: readonly number[]): { ascent: number; descent: number } {
  let ascent = 0;
  let descent = 0;
  for (let i = 1; i < profile.length; i++) {
    const a = profile[i - 1]!;
    const b = profile[i]!;
    if (b > a) ascent += b - a;
    else descent += a - b;
  }
  return { ascent, descent };
}
