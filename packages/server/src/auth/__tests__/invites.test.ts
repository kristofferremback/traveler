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

describe("the allow-list", () => {
  test("knows an invited address, whatever its case, and nobody else", async () => {
    const { createInvite, isInvited } = await import("../invites.ts");
    const email = `unit+${Date.now()}@example.com`;
    expect(isInvited(email)).toBe(false);
    await createInvite({ email });
    expect(isInvited(email)).toBe(true);
    expect(isInvited(email.toUpperCase())).toBe(true);
    expect(isInvited(`other-${email}`)).toBe(false);
  });
});
