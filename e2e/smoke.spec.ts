import { expect, test, type Page } from "@playwright/test";
import { followInvite, mintInvite, signInContext, uniqueEmail } from "./auth";

/**
 * These drive the real app in a real browser against live SL data, because the failures
 * worth catching are the ones only a browser produces: a white screen from a bad
 * import, a combobox that ignores the keyboard, a stream that never delivers.
 *
 * Locators go through roles and accessible names. When one of these breaks because a
 * name changed, that is the test doing its job -- the name is what a screen reader
 * reads out.
 */

// `getByLabel` matches substrings, and the swap button's label contains both field
// names, so field lookups are pinned to the combobox role.
const fromField = (page: Page) => page.getByRole("combobox", { name: "Från" });
const toField = (page: Page) => page.getByRole("combobox", { name: "Till" });
const journeyCards = (page: Page) => page.locator("main ul > li").filter({ hasText: "→" });

/**
 * Pick the first suggestion.
 *
 * Enter alone, no ArrowDown: the list opens with the first option already highlighted,
 * so an arrow press moves to the second. For "gullmars" that second option is the
 * street named Gullmarsplan rather than the stop, which is a perfectly good result and
 * the wrong one to assert against.
 */
async function pickStop(page: Page, field: ReturnType<typeof fromField>, query: string, expected: RegExp) {
  await field.click();
  await field.fill(query);
  const listbox = page.getByRole("listbox").first();
  await expect(listbox).toBeVisible();
  await expect(listbox.getByRole("option").first()).toContainText(expected);
  await field.press("Enter");
  await expect(field).toHaveValue(expected);
}

/**
 * Every test below runs as an invited, signed-in person, because that is the only way
 * the app can be used: /api answers 401 without a session and the app redirects to
 * /signin. The invite comes from the real CLI, so the sign-in path is exercised by
 * every run rather than only by the tests that name it.
 *
 * The cookie is fetched with the API context and copied into the browser context, so a
 * test that never opens a page does not pay for one.
 */
test.beforeEach(async ({ context, request }) => {
  await signInContext(context, request);
});

test.describe("preconditions", () => {
  test("the catalog is loaded before anything else runs", async ({ request }) => {
    // The suite waits on /api/ready rather than /api/health, because health answers 200
    // from process start while the catalog is still filling. Without this gate the run
    // would begin against an empty database, stop search would return nothing, and the
    // catalog-backed tests below would fail for a reason unrelated to the code.
    //
    // Asserting it here makes that dependency visible, and makes a broken gate fail
    // with a clear message instead of a dozen confusing ones.
    const ready = await request.get("/api/ready");
    expect(ready.status()).toBe(200);

    const body = (await ready.json()) as { ready: boolean; sites: number; indexed: number };
    expect(body.ready).toBe(true);
    expect(body.sites).toBeGreaterThan(6000);
    // Stops loaded but the index empty is a real state, and search silently returns
    // nothing in it.
    expect(body.indexed).toBeGreaterThan(6000);
  });
});

test.describe("planning a journey", () => {
  test("renders the form instead of a blank page", async ({ page }) => {
    await page.goto("/");
    await expect(fromField(page)).toBeVisible();
    await expect(toField(page)).toBeVisible();
    // The guard against a white screen: a crashed React root leaves an empty body.
    expect((await page.locator("body").innerText()).trim().length).toBeGreaterThan(20);
  });

  test("typeahead finds a stop and the keyboard selects it", async ({ page }) => {
    await page.goto("/");
    await pickStop(page, fromField(page), "gullmars", /Gullmarsplan/);
    // Selecting has to reach the URL; that is what makes a trip a shareable link.
    await expect(page).toHaveURL(/from=9091001000009189/);
  });

  test("arrow keys move through the suggestions", async ({ page }) => {
    await page.goto("/");
    const field = fromField(page);
    await field.click();
    await field.fill("gullmars");
    const listbox = page.getByRole("listbox").first();
    await expect(listbox).toBeVisible();

    const options = listbox.getByRole("option");
    await expect(options.first()).toHaveAttribute("aria-selected", "true");
    await field.press("ArrowDown");
    await expect(options.nth(1)).toHaveAttribute("aria-selected", "true");
    await field.press("ArrowUp");
    await expect(options.first()).toHaveAttribute("aria-selected", "true");

    // Escape closes without committing anything.
    await field.press("Escape");
    await expect(listbox).toBeHidden();
  });

  test("plain-ascii typing matches a stop spelled with diacritics", async ({ page }) => {
    await page.goto("/");
    // "sodermalmstorg" must find "Slussen/Södermalmstorg".
    await pickStop(page, toField(page), "sodermalmstorg", /Södermalmstorg/);
  });

  test("plans a real journey with times, duration and lines", async ({ page }) => {
    await page.goto("/");
    await pickStop(page, fromField(page), "gullmars", /Gullmarsplan/);
    await pickStop(page, toField(page), "t-centralen", /T-Centralen/);

    const first = journeyCards(page).first();
    await expect(first).toBeVisible({ timeout: 30_000 });
    await expect(first).toContainText(/\d{2}:\d{2}/);
    await expect(first).toContainText(/min|\d+ h/);
  });

  test("expanding a result reveals its legs", async ({ page }) => {
    await page.goto("/?from=9091001000009189&to=9091001000009001");
    const toggle = journeyCards(page).first().getByRole("button").first();
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
  });

  test("a shared link restores the whole search", async ({ page }) => {
    await page.goto("/?from=9091001000009189&to=9091001000009001");
    await expect(fromField(page)).toHaveValue(/Gullmarsplan/);
    await expect(toField(page)).toHaveValue(/T-Centralen/);
    await expect(journeyCards(page).first()).toBeVisible({ timeout: 30_000 });
  });

  test("swapping endpoints updates both fields and the URL", async ({ page }) => {
    await page.goto("/?from=9091001000009189&to=9091001000009001");
    await expect(fromField(page)).toHaveValue(/Gullmarsplan/);

    await page.getByRole("button", { name: /byt plats/i }).click();

    await expect(page).toHaveURL(/from=9091001000009001/);
    await expect(page).toHaveURL(/to=9091001000009189/);
    await expect(fromField(page)).toHaveValue(/T-Centralen/);
    await expect(toField(page)).toHaveValue(/Gullmarsplan/);
  });

  test("typing over a selected stop keeps what was typed", async ({ page }) => {
    // Regression: the value-sync effect treated this deselection as an external clear
    // and wiped the field on the first keystroke.
    await page.goto("/?from=9091001000009189&to=9091001000009001");
    const field = fromField(page);
    await expect(field).toHaveValue(/Gullmarsplan/);
    await field.click();
    await field.fill("Slussen");
    await expect(field).toHaveValue("Slussen");
  });

  test("going Back clears a field the URL no longer names", async ({ page }) => {
    // Regression: local state outlived its URL parameter, so Back showed a stop that
    // was no longer part of the search.
    await page.goto("/");
    await pickStop(page, fromField(page), "gullmars", /Gullmarsplan/);
    await page.goto("/");
    await expect(fromField(page)).toHaveValue("");
  });

  test("shows the map on request", async ({ page }) => {
    await page.goto("/?from=9091001000009189&to=9091001000009001");
    await expect(journeyCards(page).first()).toBeVisible({ timeout: 30_000 });
    await page.getByRole("button", { name: "Karta" }).click();
    await expect(page.getByRole("application", { name: /karta/i })).toBeVisible();
  });
});

test.describe("departures", () => {
  test("streams a live board for a stop", async ({ page }) => {
    await page.goto("/stop/9189");
    await expect(page.getByRole("heading", { name: "Gullmarsplan" })).toBeVisible();
    const board = page.getByRole("region", { name: /avgångar/i });
    await expect(board.locator("li").first()).toBeVisible({ timeout: 30_000 });
    await expect(board).toContainText(/\d{2}:\d{2}|Nu/);
  });

  test("a mode filter can always be undone", async ({ page }) => {
    // Regression: filtering narrowed the stream itself, which removed the tabs and
    // left no way back to "Alla".
    await page.goto("/stop/9189");
    const tablist = page.getByRole("tablist", { name: /färdmedel/i });
    await expect(tablist).toBeVisible({ timeout: 30_000 });

    const metro = tablist.getByRole("tab", { name: "Tunnelbana" });
    await metro.click();
    await expect(metro).toHaveAttribute("aria-selected", "true");

    const all = tablist.getByRole("tab", { name: "Alla" });
    await expect(all).toBeVisible();
    await all.click();
    await expect(all).toHaveAttribute("aria-selected", "true");
  });

  test("'Res hit' carries the journey planner's id, not the departures id", async ({ page }) => {
    // Regression: this linked with the numeric site id, which the planner silently
    // returns nothing for.
    await page.goto("/stop/9189");
    const link = page.getByRole("link", { name: /res hit/i });
    await expect(link).toBeVisible({ timeout: 30_000 });
    await expect(link).toHaveAttribute("href", /to=9091001000009189/);
  });
});

test.describe("commute engine", () => {
  // Jarlaberg, Nacka. The walking neighbourhood is computed live against Valhalla on
  // first use, so the first of these is the slow one.
  const home = "59.31557,18.16948";

  test("the walking neighbourhood knows the pier is uphill on the way home", async ({ request }) => {
    test.setTimeout(90_000);
    const res = await request.get(`/api/neighbourhood?lat=59.31557&lon=18.16948&maxWalkMinutes=20`);
    expect(res.status()).toBe(200);
    const body = await res.json();
    const names = body.stops.map((s: { name: string }) => s.name);
    expect(names).toContain("Jarlaberg");
    expect(names).toContain("Nacka trafikplats");
    const pier = body.stops.find((s: { name: string; mode: string }) => s.name === "Nacka strand" && s.mode === "SHIP");
    expect(pier).toBeTruthy();
    // 982 m and a 58 m climb: about 10 min down to the boat, about 15 back up.
    expect(pier.secondsTo).toBeGreaterThan(8 * 60);
    expect(pier.secondsFrom - pier.secondsTo).toBeGreaterThan(4 * 60);
    // Water in the way: Blockhusudden is 1 km as the crow flies and not in the list.
    expect(names).not.toContain("Blockhusudden");
  });

  test("home from Slussen ranks real options, one per vehicle, with a recommendation", async ({ request }) => {
    test.setTimeout(90_000);
    const res = await request.get(`/api/commute?from=9091001000009192&to=${home}`);
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.enumerated).toBe("destination");
    expect(body.options.length).toBeGreaterThan(3);
    const statuses = body.options.map((o: { status: string }) => o.status);
    expect(statuses.filter((s: string) => s === "recommended")).toHaveLength(1);
    // One row per vehicle: no two options ride exactly the same runs.
    const keys = body.options.map((o: { vehicleKey: string }) => o.vehicleKey);
    expect(new Set(keys).size).toBe(keys.length);
    // Every option ends with our own walk from a neighbourhood stop, not SL's estimate.
    for (const o of body.options) {
      expect(o.destination.estimated).toBe(false);
      expect(o.destination.stop).not.toBeNull();
      expect(new Date(o.arriveAt).getTime()).toBeGreaterThan(new Date(o.leaveAt).getTime());
    }
    // Missed options, if any, sort after live ones.
    const firstMissed = statuses.indexOf("missed");
    if (firstMissed !== -1) expect(statuses.slice(firstMissed).every((s: string) => s === "missed")).toBe(true);
  });

  test("a mistyped place id is a 404, not a fuzzy match in Norrtälje", async ({ request }) => {
    const res = await request.get(`/api/commute?from=nonsense&to=${home}`);
    expect(res.status()).toBe(404);
    expect((await res.json()).error.code).toBe("unknown_place");
  });
});

test.describe("other surfaces", () => {
  test("disruptions default to real disruptions, not every notice", async ({ page }) => {
    await page.goto("/disruptions");
    await expect(page.getByRole("heading", { name: "Trafikläget" })).toBeVisible();
    await expect(page.locator("main li").first()).toBeVisible({ timeout: 30_000 });

    const major = await page.locator("main ul > li").count();
    await page.getByRole("tab", { name: "Allt" }).click();
    await expect
      .poll(() => page.locator("main ul > li").count(), { timeout: 20_000 })
      .toBeGreaterThan(major);
  });

  test("the personal-data API is gone, not merely unmounted", async ({ request }) => {
    // These were built before any feature needed them and served unauthenticated reads
    // and writes. On a public deployment that is a stranger's write access to personal
    // places. Removed rather than left dormant; this fails if they come back without
    // authentication.
    for (const path of ["/api/saved/places", "/api/saved/journeys"]) {
      expect((await request.get(path)).status()).toBe(404);
      expect((await request.post(path, { data: {} })).status()).toBe(404);
      expect((await request.delete(path)).status()).toBe(404);
    }
  });

  test("an unmatched API path is a 404, not the app shell", async ({ request }) => {
    // The SPA fallback answers unmatched GETs with index.html. It must not do that for
    // /api, or a client bug surfaces as a JSON parse error pointing at the wrong place.
    const res = await request.get("/api/nonsense");
    expect(res.status()).toBe(404);
    expect(res.headers()["content-type"]).toContain("application/json");
    expect((await res.json()).error.code).toBe("not_found");
  });

  test("the admin sync endpoint is absent without a token", async ({ request }) => {
    // It downloads about 10 MB and rewrites three tables. Registered only when
    // ADMIN_TOKEN is set, which the test server does not set.
    expect((await request.post("/api/catalog/sync")).status()).toBe(404);
  });

  test("an unknown route says so instead of going blank", async ({ page }) => {
    await page.goto("/nope");
    await expect(page.getByText("Sidan finns inte.")).toBeVisible();
  });

  test("bottom navigation moves between surfaces", async ({ page }) => {
    await page.goto("/");
    const nav = page.getByRole("navigation", { name: "Huvudmeny" });
    await nav.getByRole("link", { name: /trafikläget/i }).click();
    await expect(page).toHaveURL(/\/disruptions$/);
    await nav.getByRole("link", { name: "Nära" }).click();
    await expect(page).toHaveURL(/\/nearby$/);
  });

  test("every touch target clears 44 px", async ({ page }) => {
    await page.goto("/");
    const small = await page.evaluate(() =>
      [...document.querySelectorAll("button, a[href], input, [role=tab]")]
        .filter((el) => {
          const r = el.getBoundingClientRect();
          return r.width > 0 && r.height > 0 && r.height < 44;
        })
        .map((el) => `${el.tagName} h=${Math.round(el.getBoundingClientRect().height)}`),
    );
    expect(small).toEqual([]);
  });

  test("survives an API outage without a white screen", async ({ page }) => {
    await page.route("**/api/journeys*", (route) => route.abort());
    await page.goto("/?from=9091001000009189&to=9091001000009001");
    await expect(page.getByRole("button", { name: "Försök igen" })).toBeVisible();
    expect((await page.locator("body").innerText()).trim().length).toBeGreaterThan(20);
  });
});

test.describe("sign-in and the gate", () => {
  test("answers 401 JSON when the API is called without a session", async ({
    playwright,
    baseURL,
  }) => {
    // A context of its own: the suite's own `request` is signed in by the beforeEach,
    // which is exactly the state this test must not be in.
    const anon = await playwright.request.newContext({ baseURL });

    for (const path of [
      "/api/places/search?q=slussen",
      "/api/commute?from=9091001000009192&to=59.31557,18.16948",
      "/api/sites/9192/departures",
      "/api/me",
    ]) {
      const res = await anon.get(path);
      expect(res.status(), path).toBe(401);
      expect(res.headers()["content-type"]).toContain("application/json");
      expect((await res.json()).error.code).toBe("unauthenticated");
    }

    // The probes stay open: a platform health check runs before anyone signs in.
    expect((await anon.get("/api/health")).status()).toBe(200);
    expect((await anon.get("/api/ready")).status()).toBe(200);

    await anon.dispose();
  });

  test("sends a signed-out browser to the sign-in page", async ({ browser }) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto("/");
    await expect(page).toHaveURL(/\/signin$/);
    await expect(page.getByRole("button", { name: "Logga in med passkey" })).toBeVisible();
    // No email field, no password: an invite is the only way to a new account.
    await expect(page.getByText("Ny här? Öppna din inbjudningslänk.")).toBeVisible();
    await context.close();
  });

  test("signs in through a CLI invite link and reaches the app", async ({ browser }) => {
    const context = await browser.newContext();
    const page = await context.newPage();

    await followInvite(page, mintInvite(uniqueEmail()));
    await expect(page.getByRole("heading", { name: "Välkommen" })).toBeVisible();

    // "Hoppa över" is a real way out; adding a passkey must not be a wall.
    await page.getByRole("link", { name: "Hoppa över" }).click();
    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByRole("combobox", { name: "Från" })).toBeVisible();

    await context.close();
  });

  test("refuses a reused invite link", async ({ browser }) => {
    const url = mintInvite(uniqueEmail());

    const first = await browser.newContext();
    await followInvite(await first.newPage(), url);
    await first.close();

    // Someone forwarded the link, or it is sitting in a chat log.
    const second = await browser.newContext();
    const page = await second.newPage();
    await page.goto(url);
    await expect(page.getByText("Länken har redan använts eller gått ut. Be om en ny.")).toBeVisible();
    // Shown the message and not signed in, which is the part that matters.
    expect((await page.request.get("/api/me")).status()).toBe(401);
    await second.close();
  });

  test("does not serve the public magic-link or email sign-up endpoints", async ({
    playwright,
    baseURL,
  }) => {
    // The magic-link plugin's own endpoint mints a link for any address that asks,
    // which would make an invite-only instance self-serve. It is not routed.
    const anon = await playwright.request.newContext({ baseURL });

    const magic = await anon.post("/api/auth/sign-in/magic-link", {
      data: { email: "stranger@example.com" },
    });
    expect(magic.status()).toBe(404);

    const signUp = await anon.post("/api/auth/sign-up/email", {
      data: { email: "stranger@example.com", password: "password1234", name: "Stranger" },
    });
    expect(signUp.status()).toBe(400);

    await anon.dispose();
  });

  test("accepts an API key on the API and refuses a wrong one", async ({
    request,
    playwright,
    baseURL,
  }) => {
    // The signed-in context mints the key, the way the settings page does.
    const created = await request.post("/api/auth/api-key/create", {
      data: { name: "e2e" },
      headers: { origin: baseURL! },
    });
    expect(created.status()).toBe(200);
    const key = (await created.json()).key as string;
    expect(key.length).toBeGreaterThan(20);

    const agent = await playwright.request.newContext({
      baseURL,
      extraHTTPHeaders: { "x-api-key": key },
    });
    expect((await agent.get("/api/places/search?q=slussen")).status()).toBe(200);
    await agent.dispose();

    // getSession throws rather than returning null for a key it does not know; that has
    // to surface as 401 rather than a 500.
    const wrong = await playwright.request.newContext({
      baseURL,
      extraHTTPHeaders: { "x-api-key": "not-a-real-key" },
    });
    const refused = await wrong.get("/api/places/search?q=slussen");
    expect(refused.status()).toBe(401);
    expect((await refused.json()).error.code).toBe("unauthenticated");
    await wrong.dispose();
  });

  test("the settings page hands over a working invite link and a QR code", async ({
    page,
    browser,
  }) => {
    await page.goto("/settings");
    const email = uniqueEmail();
    await page.getByLabel("E-postadress").fill(email);
    await page.getByRole("button", { name: "Skapa inbjudan" }).click();

    const link = page.getByLabel("Inbjudningslänk");
    await expect(link).toBeVisible();
    await expect(page.getByRole("img", { name: /QR-kod/ })).toBeVisible();

    const url = await link.inputValue();
    expect(url).toContain("/api/auth/magic-link/verify?token=");

    // The link is the product of this screen, so it has to work somewhere else.
    const invited = await browser.newContext();
    await followInvite(await invited.newPage(), url);
    await invited.close();
  });

  test("creates an API key from the settings page and shows it once", async ({ page }) => {
    await page.goto("/settings");
    await page.getByLabel("Namn på nyckeln").fill("Agent");
    await page.getByRole("button", { name: "Skapa nyckel" }).click();

    await expect(page.getByText("Kopiera nyckeln nu. Den visas inte igen.")).toBeVisible();
    const value = await page.getByLabel("API-nyckel").inputValue();
    expect(value.length).toBeGreaterThan(20);

    // The list shows the key without its secret: only the first characters are stored.
    await expect(page.getByText("Agent", { exact: false }).first()).toBeVisible();
    await page.reload();
    await expect(page.getByText(value)).toHaveCount(0);
  });

  test("adds a passkey and signs in with it", async ({ browser }) => {
    const context = await browser.newContext();
    const page = await context.newPage();

    // Chrome's virtual authenticator: a platform authenticator (transport "internal",
    // like a phone's fingerprint sensor) that reports the user as verified, so the
    // WebAuthn calls resolve without a human touching anything.
    const cdp = await context.newCDPSession(page);
    await cdp.send("WebAuthn.enable");
    const { authenticatorId } = await cdp.send("WebAuthn.addVirtualAuthenticator", {
      options: {
        protocol: "ctap2",
        transport: "internal",
        hasResidentKey: true,
        hasUserVerification: true,
        isUserVerified: true,
        automaticPresenceSimulation: true,
      },
    });
    expect(authenticatorId).toBeTruthy();

    await followInvite(page, mintInvite(uniqueEmail()));
    await page.getByRole("button", { name: "Lägg till passkey" }).click();
    await expect(page).toHaveURL(/\/$/);

    await page.goto("/settings");
    await expect(page.getByText(/tillagd /)).toBeVisible();

    await page.getByRole("button", { name: "Logga ut" }).click();
    await expect(page).toHaveURL(/\/signin$/);

    // The point of the whole exercise: a second sign-in with no link and no password.
    await page.getByRole("button", { name: "Logga in med passkey" }).click();
    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByRole("combobox", { name: "Från" })).toBeVisible();

    await context.close();
  });

  test("signs out and the app is closed again", async ({ page }) => {
    await page.goto("/settings");
    await page.getByRole("button", { name: "Logga ut" }).click();
    await expect(page).toHaveURL(/\/signin$/);
    await page.goto("/");
    await expect(page).toHaveURL(/\/signin$/);
  });
});
