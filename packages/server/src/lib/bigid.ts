/**
 * SL identifiers do not fit in a JavaScript number.
 *
 * A `gid` looks like 9091001000000102 -- sixteen digits, about 9.09e15, comfortably
 * past Number.MAX_SAFE_INTEGER (9.007e15). `JSON.parse` reads them as doubles and
 * rounds. Measured against the live catalog that turns 6510 distinct sites into 3493:
 * sites 103, 104 and 105 all become 9091001000000104.
 *
 * That matters because `gid` is the join key between the SL Transport catalog and the
 * journey planner. A rounded gid does not error -- it plans a trip to a different
 * island in the archipelago and looks entirely plausible doing it.
 *
 * So the identifier fields are quoted in the raw text before parsing, and stay strings
 * for their whole life. The scanner below tracks string state so a `"gid":` appearing
 * inside a disruption message is left alone.
 */

const DIGITS = /[0-9]/;

function isWhitespace(ch: string): boolean {
  return ch === " " || ch === "\t" || ch === "\n" || ch === "\r";
}

/** Read a JSON string starting at the opening quote. Returns its end index (exclusive). */
function scanString(text: string, start: number): number {
  let i = start + 1;
  while (i < text.length) {
    const ch = text[i];
    if (ch === "\\") {
      i += 2;
      continue;
    }
    if (ch === '"') return i + 1;
    i++;
  }
  return i;
}

/**
 * Parse JSON, but first rewrite the values of `keys` from bare integers into strings
 * whenever they are long enough to lose precision.
 *
 * Shorter values are quoted too, so a field's type never depends on the magnitude of a
 * particular row -- a caller reading `site.gid` always gets a string.
 */
export function parseJsonPreservingIds<T>(text: string, keys: readonly string[]): T {
  const wanted = new Set(keys);
  let out = "";
  let copiedTo = 0;
  let i = 0;

  while (i < text.length) {
    const ch = text[i];

    if (ch !== '"') {
      i++;
      continue;
    }

    const stringEnd = scanString(text, i);
    const token = text.slice(i + 1, stringEnd - 1);

    if (!wanted.has(token)) {
      // Not an id field. Skipping past the whole string is also what keeps a quoted
      // "gid" inside a message body from being treated as a key.
      i = stringEnd;
      continue;
    }

    // Confirm this string is a key: whitespace then a colon.
    let j = stringEnd;
    while (j < text.length && isWhitespace(text[j]!)) j++;
    if (text[j] !== ":") {
      i = stringEnd;
      continue;
    }
    j++;
    while (j < text.length && isWhitespace(text[j]!)) j++;

    // Only bare integers need rewriting; already-quoted and null values are fine.
    const numberStart = j;
    if (text[j] === "-") j++;
    let digits = 0;
    while (j < text.length && DIGITS.test(text[j]!)) {
      j++;
      digits++;
    }
    const next = text[j];
    const isPlainInteger =
      digits > 0 && next !== "." && next !== "e" && next !== "E";

    if (!isPlainInteger) {
      i = stringEnd;
      continue;
    }

    out += text.slice(copiedTo, numberStart);
    out += `"${text.slice(numberStart, j)}"`;
    copiedTo = j;
    i = j;
  }

  out += text.slice(copiedTo);
  return JSON.parse(out) as T;
}

/** Identifier fields across SL's catalog endpoints that exceed the safe integer range. */
export const SL_ID_KEYS = ["gid", "pattern_point_gid"] as const;
