import { defineConfig, devices } from "@playwright/test";
import { E2E_AUTH_SECRET } from "./e2e/auth";

/**
 * End-to-end against a running Traveler and the live SL APIs.
 *
 * The server is started by the config so a bare `bunx playwright test` works, and it is
 * reused if one is already listening. Retries are on because a few assertions depend on
 * live upstream data that can be briefly slow; the app behaviour under test is not
 * itself flaky.
 */
export default defineConfig({
  testDir: "./e2e",
  timeout: 45_000,
  expect: { timeout: 15_000 },
  retries: process.env.CI ? 2 : 1,
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: process.env.E2E_BASE ?? "http://localhost:3111",
    locale: "sv-SE",
    timezoneId: "Europe/Stockholm",
    trace: "retain-on-failure",
  },
  projects: [
    // A phone, because that is where this is used.
    { name: "mobile", use: { ...devices["Pixel 7"] } },
  ],
  webServer: {
    /**
     * Builds the frontend, then starts the server on a database of the suite's own.
     *
     * Three things this has to get right, each of which was wrong at some point:
     *
     * - Build first. A clean checkout has no `packages/web/dist`, so the server would
     *   serve its API-only JSON at `/` and every test would fail on a blank page.
     *   Building here also means the suite can never pass against a stale bundle.
     * - Its own database under `.e2e/`, not `packages/server/data/traveler.db`. Riding
     *   on the developer's synced copy is why an earlier version of this suite was
     *   green on this machine and would have failed on a fresh clone or in CI.
     * - Run from the repository root so DATABASE_PATH, which resolves against the
     *   process working directory, means what it says.
     */
    command: "bun run build && bun packages/server/src/index.ts",
    env: {
      PORT: "3111",
      DATABASE_PATH: "./.e2e/traveler.db",
      CATALOG_SYNC_ON_BOOT: "true",
      LOG_LEVEL: "warn",
      // The suite signs itself in, so it needs the same auth configuration the invite
      // CLI uses. AUTH_BASE_URL has to name the port the browser reaches, because it is
      // the passkey relying party and the base of every invite link the CLI prints.
      AUTH_SECRET: E2E_AUTH_SECRET,
      AUTH_BASE_URL: "http://localhost:3111",
    },
    /**
     * Readiness, not liveness.
     *
     * `/api/health` answers 200 from process start by design, so that a platform health
     * check cannot kill a container during its first catalog sync. Waiting on it here
     * would start the suite against an empty database: stop search returns nothing, and
     * every catalog-backed test fails for a reason unrelated to the code under test.
     * `/api/ready` answers 503 until the stops are loaded and the search index is built.
     */
    url: "http://localhost:3111/api/ready",
    // A first run on a clean checkout builds the frontend and pulls about 10 MB from SL
    // before it is ready. Later runs reuse the synced database and start in seconds.
    timeout: 240_000,
    // The run owns its server. Reusing whatever is on the port tests a build that may
    // predate the change under test.
    reuseExistingServer: false,
    stdout: "pipe",
  },
});
