import { execFileSync } from "node:child_process";
import { expect, type APIRequestContext, type BrowserContext, type Page } from "@playwright/test";

/**
 * Signing key for the suite's server and for the invite CLI the tests shell out to.
 * Both have to sign with the same key or the link the CLI prints is not one the server
 * will accept. Shared with playwright.config.ts, which puts it in the server's env.
 */
export const E2E_AUTH_SECRET = "e2e-secret-not-used-anywhere-else-0123456789";

const E2E_BASE = "http://localhost:3111";

/**
 * Mint an invite the way a fresh instance has to: on the server, from the CLI.
 *
 * This is deliberately the real command rather than a direct call into the auth code,
 * because "the CLI prints a link that works" is the only way into an instance where
 * nobody has an account yet, and it is the step that a change to the database path, the
 * secret or the base URL silently breaks.
 */
export function mintInvite(email: string): string {
  const stdout = execFileSync("bun", ["packages/server/src/cli/invite.ts", email], {
    encoding: "utf8",
    env: {
      ...process.env,
      DATABASE_PATH: "./.e2e/traveler.db",
      AUTH_BASE_URL: E2E_BASE,
      AUTH_SECRET: E2E_AUTH_SECRET,
    },
    // The human-readable half goes to stderr; only the link is on stdout.
    stdio: ["ignore", "pipe", "ignore"],
  });
  const url = stdout.trim();
  expect(url).toMatch(/^http:\/\/localhost:3111\/invite#token=/);
  return url;
}

/**
 * The request the /invite page makes when its button is pressed. Tests that only need
 * a session skip the page and make it directly.
 */
export function verifyUrlOf(inviteUrl: string): string {
  const token = new URLSearchParams(new URL(inviteUrl).hash.slice(1)).get("token");
  expect(token).toBeTruthy();
  return `${E2E_BASE}/api/auth/magic-link/verify?token=${encodeURIComponent(token!)}&callbackURL=%2Fsignin`;
}

let counter = 0;

/** A fresh address per call, so no two tests share an account. */
export function uniqueEmail(): string {
  counter += 1;
  return `e2e+${Date.now()}-${counter}@example.com`;
}

/**
 * Sign an API request context in by following an invite link. The context keeps the
 * session cookie, so every later call through it is authenticated.
 */
export async function signInRequest(
  request: APIRequestContext,
  email = uniqueEmail(),
): Promise<void> {
  const res = await request.get(verifyUrlOf(mintInvite(email)));
  expect(res.ok()).toBeTruthy();
}

/**
 * Sign a browser context in without spending a page load on it: follow the invite with
 * the API context and copy the cookie across.
 */
export async function signInContext(
  context: BrowserContext,
  request: APIRequestContext,
  email = uniqueEmail(),
): Promise<void> {
  await signInRequest(request, email);
  const { cookies } = await request.storageState();
  await context.addCookies(cookies);
}

/** Follow an invite in the browser, the way an invited person does. */
export async function followInvite(page: Page, url: string): Promise<void> {
  await page.goto(url);
  await page.getByRole("button", { name: "Fortsätt" }).click();
  await expect(page).toHaveURL(/\/$/);
}
