import { describe, expect, test } from "bun:test";
import { SL_ID_KEYS, parseJsonPreservingIds } from "../bigid.ts";

describe("parseJsonPreservingIds", () => {
  test("keeps 16-digit ids that JSON.parse would round", () => {
    const raw = `[{"id":103,"gid":9091001000000103},{"id":104,"gid":9091001000000104},{"id":105,"gid":9091001000000105}]`;

    // The failure being guarded against: these three collapse to one id.
    const rounded = new Set((JSON.parse(raw) as { gid: number }[]).map((s) => String(s.gid)));
    expect(rounded.size).toBe(1);

    const parsed = parseJsonPreservingIds<{ id: number; gid: string }[]>(raw, SL_ID_KEYS);
    expect(parsed.map((s) => s.gid)).toEqual([
      "9091001000000103",
      "9091001000000104",
      "9091001000000105",
    ]);
    expect(typeof parsed[0]!.gid).toBe("string");
  });

  test("leaves a 'gid' appearing inside a string value alone", () => {
    const raw = JSON.stringify([{ note: 'the "gid": 123 in a message', gid: 9091001000000104 }]);
    const parsed = parseJsonPreservingIds<{ note: string; gid: string }[]>(raw, SL_ID_KEYS);
    expect(parsed[0]!.note).toBe('the "gid": 123 in a message');
    expect(parsed[0]!.gid).toBe("9091001000000104");
  });

  test("passes through nulls, floats and already-quoted values", () => {
    const raw = `[{"gid":null},{"gid":"9091001000000104"},{"lat":59.33,"gid":1}]`;
    const parsed = parseJsonPreservingIds<{ gid: string | null; lat?: number }[]>(raw, SL_ID_KEYS);
    expect(parsed[0]!.gid).toBeNull();
    expect(parsed[1]!.gid).toBe("9091001000000104");
    expect(parsed[2]!.gid).toBe("1");
    expect(parsed[2]!.lat).toBe(59.33);
  });
});
