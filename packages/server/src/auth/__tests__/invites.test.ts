import { describe, expect, test } from "bun:test";
import { inviteUrl, tokenOf } from "../invites.ts";
import { env } from "../../env.ts";

describe("invite links", () => {
  test("carry the token in the fragment, so a fetch of the link cannot spend it", () => {
    const url = inviteUrl(
      `${env.AUTH_BASE_URL}/api/auth/magic-link/verify?token=abc%2B123&callbackURL=%2Fwelcome`,
    );
    const parsed = new URL(url);
    expect(parsed.origin + parsed.pathname).toBe(`${env.AUTH_BASE_URL}/invite`);
    expect(parsed.search).toBe("");
    expect(tokenOf(url)).toBe("abc+123");
  });

  test("refuse a verify URL without a token", () => {
    expect(() => inviteUrl(`${env.AUTH_BASE_URL}/api/auth/magic-link/verify`)).toThrow();
  });
});
