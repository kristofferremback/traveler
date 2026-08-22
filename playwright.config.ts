import { defineConfig, devices } from "@playwright/test";

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
    // `cwd` is set explicitly and DATABASE_PATH is relative to it. Running this through
    // `bun run --cwd` instead moved the process into packages/server while the path
    // stayed repo-relative, which silently created an empty database one level deeper
    // and made every catalog-backed assertion fail for the wrong reason.
    command: "bun src/index.ts",
    cwd: "packages/server",
    env: { PORT: "3111", DATABASE_PATH: "./data/traveler.db", LOG_LEVEL: "warn" },
    url: "http://localhost:3111/api/health",
    // The run owns its server. Reusing whatever happens to be on the port tests a build
    // that may predate the change under test.
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
