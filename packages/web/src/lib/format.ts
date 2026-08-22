/**
 * Times are always rendered in Europe/Stockholm, never the device's zone.
 *
 * Someone checking whether they can still catch the last train home while sitting in
 * an airport in another country wants Stockholm's clock, not the one on the wall next
 * to them. The server sends absolute instants precisely so this choice can be made here.
 */
const STOCKHOLM = "Europe/Stockholm";

const timeFormat = new Intl.DateTimeFormat("sv-SE", {
  timeZone: STOCKHOLM,
  hour: "2-digit",
  minute: "2-digit",
});

const dayFormat = new Intl.DateTimeFormat("sv-SE", {
  timeZone: STOCKHOLM,
  weekday: "short",
  day: "numeric",
  month: "short",
});

export function formatTime(instant: string | null | undefined): string {
  if (!instant) return "--:--";
  const date = new Date(instant);
  return Number.isNaN(date.getTime()) ? "--:--" : timeFormat.format(date);
}

export function formatDay(instant: string | null | undefined): string {
  if (!instant) return "";
  const date = new Date(instant);
  return Number.isNaN(date.getTime()) ? "" : dayFormat.format(date);
}

/** Stockholm's calendar day, so "today" flips at local midnight rather than UTC. */
function stockholmDay(date: Date): string {
  return new Intl.DateTimeFormat("sv-SE", { timeZone: STOCKHOLM }).format(date);
}

export function dayLabel(instant: string | null | undefined): string | null {
  if (!instant) return null;
  const date = new Date(instant);
  if (Number.isNaN(date.getTime())) return null;

  const today = stockholmDay(new Date());
  const target = stockholmDay(date);
  if (target === today) return null; // Today needs no label; every other day does.

  const tomorrow = stockholmDay(new Date(Date.now() + 86_400_000));
  if (target === tomorrow) return "imorgon";
  return formatDay(instant);
}

export function formatDuration(seconds: number): string {
  const total = Math.max(0, Math.round(seconds / 60));
  if (total < 60) return `${total} min`;
  const hours = Math.floor(total / 60);
  const minutes = total % 60;
  return minutes === 0 ? `${hours} h` : `${hours} h ${minutes} min`;
}

/**
 * Minutes until departure, or null past it.
 *
 * SL's own `display` string is preferred wherever it exists because it handles "Nu"
 * and the switch to a clock time for anything far out. This is for the cases that have
 * no display string, such as a planned journey.
 */
export function minutesUntil(instant: string | null | undefined): number | null {
  if (!instant) return null;
  const diff = new Date(instant).getTime() - Date.now();
  if (Number.isNaN(diff)) return null;
  return Math.round(diff / 60_000);
}

export function formatCountdown(instant: string | null | undefined): string {
  const minutes = minutesUntil(instant);
  if (minutes === null) return "";
  if (minutes <= 0) return "nu";
  if (minutes < 60) return `${minutes} min`;
  return formatTime(instant);
}

export function formatDelay(seconds: number | null): string | null {
  if (seconds === null || Math.abs(seconds) < 60) return null;
  const minutes = Math.round(seconds / 60);
  return minutes > 0 ? `+${minutes} min` : `${minutes} min`;
}

export function formatDistance(metres: number | null): string | null {
  if (metres === null) return null;
  if (metres < 1000) return `${Math.round(metres / 10) * 10} m`;
  return `${(metres / 1000).toFixed(metres < 10_000 ? 1 : 0)} km`;
}

/**
 * Turn a `datetime-local` value into an absolute instant, reading it as Stockholm time.
 *
 * `new Date("2026-08-23T08:30")` uses the device's zone. For a phone set to another
 * country that silently shifts the requested departure by the offset between the two,
 * which is the same class of bug the server's SL timestamps have, arriving from the
 * other direction. The two-pass offset lookup converges at DST boundaries, where the
 * offset depends on the instant being solved for.
 */
export function localInputToInstant(value: string): string | null {
  if (!value) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(value);
  if (!match) return null;

  const [, year, month, day, hour, minute] = match;
  const wallMs = Date.UTC(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
  );

  let guess = new Date(wallMs - stockholmOffsetMs(new Date(wallMs)));
  guess = new Date(wallMs - stockholmOffsetMs(guess));
  return Number.isNaN(guess.getTime()) ? null : guess.toISOString();
}

/** Milliseconds Stockholm is ahead of UTC at a given instant. */
function stockholmOffsetMs(instant: Date): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: STOCKHOLM,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(instant);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  const asUtc = Date.UTC(
    get("year"),
    get("month") - 1,
    get("day"),
    get("hour") % 24,
    get("minute"),
    get("second"),
  );
  return asUtc - instant.getTime();
}

export function instantToLocalInput(instant: string): string {
  const parts = new Intl.DateTimeFormat("sv-SE", {
    timeZone: STOCKHOLM,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(new Date(instant));
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "00";
  return `${get("year")}-${get("month")}-${get("day")}T${get("hour")}:${get("minute")}`;
}
