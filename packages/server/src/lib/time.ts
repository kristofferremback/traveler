/**
 * SL's three APIs disagree about time.
 *
 *   SL Transport      "2026-08-22T23:50:00"   -- naive, Europe/Stockholm, no offset
 *   Journey planner   "2026-08-22T21:48:42Z"  -- UTC
 *   Deviations        "2026-08-21T07:50:45+02:00" -- offset included
 *
 * Reading the first as UTC puts every summer departure two hours in the past, which
 * is exactly the kind of bug that looks like "realtime is broken". Everything is
 * funnelled through here and leaves as an absolute instant.
 */

export const STOCKHOLM = "Europe/Stockholm";

const partsFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: STOCKHOLM,
  hour12: false,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});

/** Milliseconds Stockholm is ahead of UTC at the given instant. */
function offsetAt(instant: Date): number {
  const parts = partsFormatter.formatToParts(instant);
  const get = (t: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((p) => p.type === t)?.value ?? 0);
  // `hour` comes back as 24 at midnight under hour12:false in some ICU versions.
  const hour = get("hour") % 24;
  const asUtc = Date.UTC(
    get("year"),
    get("month") - 1,
    get("day"),
    hour,
    get("minute"),
    get("second"),
  );
  return asUtc - instant.getTime();
}

const NAIVE = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?(?:\.(\d+))?$/;

/**
 * Parse a timestamp that may or may not carry an offset. Bare timestamps are read as
 * Europe/Stockholm wall-clock time.
 *
 * The two-pass offset lookup matters at DST boundaries: the offset that applies to a
 * wall-clock time depends on the instant it maps to, which is what we are solving for.
 * One correction pass converges everywhere except inside the one repeated hour, where
 * either answer is defensible and we take the first.
 */
export function parseSlTime(raw: string | null | undefined): Date | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;

  const naive = NAIVE.exec(trimmed);
  if (!naive) {
    const parsed = new Date(trimmed);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }

  const [, y, mo, d, h, mi, s, frac] = naive;
  const wallMs = Date.UTC(
    Number(y),
    Number(mo) - 1,
    Number(d),
    Number(h),
    Number(mi),
    Number(s ?? 0),
    frac ? Number(frac.padEnd(3, "0").slice(0, 3)) : 0,
  );

  let guess = new Date(wallMs - offsetAt(new Date(wallMs)));
  guess = new Date(wallMs - offsetAt(guess));
  return guess;
}

/** ISO 8601 with a real offset. The only timestamp format that leaves this server. */
export function toInstant(value: Date | string | null | undefined): string | null {
  const date = value instanceof Date ? value : parseSlTime(value);
  if (!date || Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

export function nowInstant(): string {
  return new Date().toISOString();
}

/** `YYYYMMDD` / `HHMM` in Stockholm local time -- the format /trips validates against. */
export function toSlDateTime(instant: Date): { date: string; time: string } {
  const parts = partsFormatter.formatToParts(instant);
  const get = (t: Intl.DateTimeFormatPartTypes) =>
    parts.find((p) => p.type === t)?.value ?? "00";
  const hour = String(Number(get("hour")) % 24).padStart(2, "0");
  return {
    date: `${get("year")}${get("month")}${get("day")}`,
    time: `${hour}${get("minute")}`,
  };
}

export function secondsBetween(
  from: Date | string | null,
  to: Date | string | null,
): number | null {
  const a = from instanceof Date ? from : parseSlTime(from);
  const b = to instanceof Date ? to : parseSlTime(to);
  if (!a || !b) return null;
  return Math.round((b.getTime() - a.getTime()) / 1000);
}
