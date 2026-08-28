import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { followInvite, mintInvite, signInContext, signInRequest, uniqueEmail, verifyUrlOf } from "./auth";

/**
 * These drive the real app in a real browser against live SL data, because the failures
 * worth catching are the ones only a browser produces: a white screen from a bad
 * import, a combobox that ignores the keyboard, a stream that never delivers.
 *
 * Locators go through roles and accessible names. When one of these breaks because a
 * name changed, that is the test doing its job -- the name is what a screen reader
 * reads out.
 */

/**
 * The two ends of the trip, as the control on both search screens shows them: buttons
 * that say where you are going, not fields. The name is the caption plus the value, so
 * the anchor is the caption.
 */
const tripEnd = (page: Page, end: "Från" | "Till") =>
  page.getByRole("button", { name: new RegExp(`^${end}`) });
/** The field inside the search screen. Only one is ever open. */
const searchField = (page: Page) => page.getByRole("combobox");
const journeyCards = (page: Page) => page.locator("main ul > li").filter({ hasText: "→" });

/**
 * Choose a place through the search screen: open it, type, take the first suggestion.
 *
 * Enter alone, no ArrowDown: the list opens with the first option already highlighted,
 * so an arrow press moves to the second. For "gullmars" that second option is the
 * street named Gullmarsplan rather than the stop, which is a perfectly good result and
 * the wrong one to assert against.
 */
async function pickStop(page: Page, open: () => Promise<void>, query: string, expected: RegExp) {
  await open();
  const field = searchField(page);
  await expect(field).toBeVisible();
  await field.fill(query);
  const listbox = page.getByRole("listbox");
  await expect(listbox.getByRole("option").first()).toContainText(expected);
  await field.press("Enter");
  await expect(listbox).toBeHidden();
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
  test("renders the trip control instead of a blank page", async ({ page }) => {
    await page.goto("/plan");
    await expect(tripEnd(page, "Från")).toBeVisible();
    await expect(tripEnd(page, "Till")).toBeVisible();
    // The guard against a white screen: a crashed React root leaves an empty body.
    expect((await page.locator("body").innerText()).trim().length).toBeGreaterThan(20);
  });

  test("typeahead finds a stop and the keyboard selects it", async ({ page }) => {
    await page.goto("/plan");
    await pickStop(page, () => tripEnd(page, "Från").click(), "gullmars", /Gullmarsplan/);
    await expect(tripEnd(page, "Från")).toContainText(/Gullmarsplan/);
    // Selecting has to reach the URL; that is what makes a trip a shareable link.
    await expect(page).toHaveURL(/from=9091001000009189/);
  });

  test("arrow keys move through the suggestions", async ({ page }) => {
    await page.goto("/plan");
    await tripEnd(page, "Från").click();
    const field = searchField(page);
    await field.fill("gullmars");
    const listbox = page.getByRole("listbox");

    const options = listbox.getByRole("option");
    await expect(options.first()).toContainText(/Gullmarsplan/);
    await expect(options.first()).toHaveAttribute("aria-selected", "true");
    await field.press("ArrowDown");
    await expect(options.nth(1)).toHaveAttribute("aria-selected", "true");
    await field.press("ArrowUp");
    await expect(options.first()).toHaveAttribute("aria-selected", "true");

    // Escape closes without committing anything.
    await field.press("Escape");
    await expect(listbox).toBeHidden();
    await expect(tripEnd(page, "Från")).toContainText("Välj plats");
  });

  test("the field is above its results, and they arrive without moving it", async ({ page }) => {
    // The bug this replaced: the field sat at the bottom of a sheet, where the phone's
    // keyboard covers it and every suggestion under it, and the sheet resized as
    // suggestions came and went.
    await page.goto("/plan");
    await tripEnd(page, "Från").click();
    const field = searchField(page);

    const box = (await field.boundingBox())!;
    const dialog = (await page.getByRole("dialog").boundingBox())!;
    const viewport = page.viewportSize()!;
    // The screen is the screen, and the field is in its top third.
    expect(dialog.height).toBeGreaterThan(viewport.height * 0.9);
    expect(box.y).toBeLessThan(viewport.height / 3);
    // The shortcuts are under the field, never over it.
    const shortcut = (await page.getByRole("option").first().boundingBox())!;
    expect(shortcut.y).toBeGreaterThanOrEqual(box.y + box.height);

    await field.fill("gullmars");
    await expect(page.getByRole("option").first()).toContainText(/Gullmarsplan/);
    // Results replace the shortcuts inside the same region: nothing above them moved.
    expect((await field.boundingBox())!.y).toBeCloseTo(box.y, 0);
    expect((await page.getByRole("option").first().boundingBox())!.y).toBeCloseTo(shortcut.y, 0);
  });

  test("the search screen looks right in both themes", async ({ page }) => {
    // Not asserted: a screenshot is for a human to look at.
    for (const scheme of ["dark", "light"] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      await page.goto("/plan");
      await tripEnd(page, "Från").click();
      await searchField(page).fill("gullmars");
      await expect(page.getByRole("option").first()).toContainText(/Gullmarsplan/);
      await page.screenshot({ path: `.e2e/explore/search-${scheme}.png` });
      await searchField(page).press("Escape");
    }
  });

  test("plain-ascii typing matches a stop spelled with diacritics", async ({ page }) => {
    await page.goto("/plan");
    // "sodermalmstorg" must find "Slussen/Södermalmstorg".
    await pickStop(page, () => tripEnd(page, "Till").click(), "sodermalmstorg", /Södermalmstorg/);
    await expect(tripEnd(page, "Till")).toContainText(/Södermalmstorg/);
  });

  test("plans a real journey with times, duration and lines", async ({ page }) => {
    await page.goto("/plan");
    await pickStop(page, () => tripEnd(page, "Från").click(), "gullmars", /Gullmarsplan/);
    await pickStop(page, () => tripEnd(page, "Till").click(), "t-centralen", /T-Centralen/);

    const first = journeyCards(page).first();
    await expect(first).toBeVisible({ timeout: 30_000 });
    await expect(first).toContainText(/\d{2}:\d{2}/);
    await expect(first).toContainText(/min|\d+ h/);
  });

  test("expanding a result reveals its legs", async ({ page }) => {
    await page.goto("/plan?from=9091001000009189&to=9091001000009001");
    const toggle = journeyCards(page).first().getByRole("button").first();
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
  });

  test("a shared link restores the whole search", async ({ page }) => {
    await page.goto("/plan?from=9091001000009189&to=9091001000009001");
    await expect(tripEnd(page, "Från")).toContainText(/Gullmarsplan/);
    await expect(tripEnd(page, "Till")).toContainText(/T-Centralen/);
    await expect(journeyCards(page).first()).toBeVisible({ timeout: 30_000 });
  });

  test("swapping endpoints updates both fields and the URL", async ({ page }) => {
    await page.goto("/plan?from=9091001000009189&to=9091001000009001");
    await expect(tripEnd(page, "Från")).toContainText(/Gullmarsplan/);

    await page.getByRole("button", { name: /byt plats/i }).click();

    await expect(page).toHaveURL(/from=9091001000009001/);
    await expect(page).toHaveURL(/to=9091001000009189/);
    await expect(tripEnd(page, "Från")).toContainText(/T-Centralen/);
    await expect(tripEnd(page, "Till")).toContainText(/Gullmarsplan/);
  });

  test("the search screen opens empty over a chosen stop, and Back keeps it", async ({ page }) => {
    // The field searches; it does not hold the answer. Opening it over Gullmarsplan
    // offers the shortcuts rather than the word to type over, and backing out of it
    // leaves the trip as it was.
    await page.goto("/plan?from=9091001000009189&to=9091001000009001");
    await tripEnd(page, "Från").click();
    await expect(searchField(page)).toHaveValue("");

    await page.goBack();
    await expect(page.getByRole("dialog")).toBeHidden();
    await expect(tripEnd(page, "Från")).toContainText(/Gullmarsplan/);
  });

  test("going Back clears a field the URL no longer names", async ({ page }) => {
    // Regression: local state outlived its URL parameter, so Back showed a stop that
    // was no longer part of the search.
    await page.goto("/plan");
    await pickStop(page, () => tripEnd(page, "Från").click(), "gullmars", /Gullmarsplan/);
    await page.goto("/plan");
    await expect(tripEnd(page, "Från")).toContainText("Välj plats");
  });

  test("shows the map on request", async ({ page }) => {
    await page.goto("/plan?from=9091001000009189&to=9091001000009001");
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

/** Tomorrow at a Stockholm wall-clock time, as an instant. */
function tomorrowAt(hour: number, minute: number): string {
  const local = localTomorrowAt(hour, minute);
  const offset = stockholmOffsetMinutes(new Date(`${local}:00Z`));
  return new Date(Date.parse(`${local}:00Z`) - offset * 60_000).toISOString();
}

/** Tomorrow's date in Stockholm plus a time, in `datetime-local` shape. */
function localTomorrowAt(hour: number, minute: number): string {
  const day = new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Stockholm" }).format(
    new Date(Date.now() + 86_400_000),
  );
  return `${day}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

function stockholmOffsetMinutes(at: Date): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Europe/Stockholm",
    hour12: false,
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
  }).formatToParts(at);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  const wall = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour") % 24, get("minute"));
  return Math.round((wall - at.getTime()) / 60_000);
}

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

  test("home by a deadline tomorrow: nothing lands late, and the latest leave is recommended", async ({ request }) => {
    test.setTimeout(90_000);
    const deadline = tomorrowAt(17, 0);
    const res = await request.get(
      `/api/commute?from=9091001000009192&to=${home}&when=${encodeURIComponent(deadline)}&arriveBy=1`,
    );
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.arriveBy).toBe(true);
    expect(body.plannedFrom).toBe(deadline);
    expect(body.options.length).toBeGreaterThan(1);
    const live = body.options.filter((o: { status: string }) => o.status !== "missed");
    expect(live.map((o: { status: string }) => o.status)).not.toContain("missed");
    for (const o of body.options) {
      expect(new Date(o.arriveAt).getTime()).toBeLessThanOrEqual(new Date(deadline).getTime());
    }
    // The recommendation is the one you can leave latest for, penalties aside: no
    // direct ride in the list leaves after it.
    const best = body.options[0];
    expect(best.status).toBe("recommended");
    for (const o of body.options.filter((o: { transfers: number }) => o.transfers <= best.transfers)) {
      expect(new Date(o.leaveAt).getTime()).toBeLessThanOrEqual(new Date(best.leaveAt).getTime());
    }
  });

  test("arriveBy without a time is a 400", async ({ request }) => {
    const res = await request.get(`/api/commute?from=9091001000009192&to=${home}&arriveBy=1`);
    expect(res.status()).toBe(400);
    expect((await res.json()).error.code).toBe("invalid_time");
  });

  test("a mistyped place id is a 404, not a fuzzy match in Norrtälje", async ({ request }) => {
    const res = await request.get(`/api/commute?from=nonsense&to=${home}`);
    expect(res.status()).toBe(404);
    expect((await res.json()).error.code).toBe("unknown_place");
  });
});

test.describe("saved places", () => {
  /** Jarlaberg, Nacka: the stop this whole engine was built around. */
  const JARLABERG = "9091001000004030";
  const SLUSSEN = "9091001000009192";

  async function saveHome(request: APIRequestContext): Promise<number> {
    const created = await request.post("/api/places", {
      data: { label: "Hem", placeId: JARLABERG },
    });
    expect(created.status()).toBe(201);
    const { place } = await created.json();
    return place.id as number;
  }

  test("keeps places per user", async ({ request, playwright, baseURL }) => {
    const created = await request.post("/api/places", {
      data: { label: "Hem", placeId: JARLABERG },
    });
    expect(created.status()).toBe(201);
    const { place } = await created.json();
    expect(place).toMatchObject({ label: "Hem", kind: "stop", name: "Jarlaberg", ref: JARLABERG });

    // A second invited person. Ownership is a WHERE clause, so their list is empty and
    // the other person's place is a 404 rather than a 403 -- which would confirm it
    // exists.
    const other = await playwright.request.newContext({ baseURL });
    await signInRequest(other);

    const list = await other.get("/api/places");
    expect(list.status()).toBe(200);
    expect((await list.json()).places).toEqual([]);

    const foreign = await other.get(`/api/places/${place.id}`);
    expect(foreign.status()).toBe(404);
    await other.dispose();
  });

  test("computes a neighbourhood for a saved place and draws it", async ({ page, request }) => {
    // The first read routes every walk from the place against Valhalla, one request a
    // second.
    test.setTimeout(180_000);

    await page.goto("/places/new");
    await page.getByLabel("Namn").fill("Hem");
    await pickStop(page, () => page.getByRole("button", { name: "Plats" }).click(), "jarlaberg", /Jarlaberg/);
    await expect(page.getByRole("button", { name: "Plats" })).toContainText(/Jarlaberg/);
    await page.getByRole("button", { name: "Spara" }).click();

    await expect(page).toHaveURL(/\/places\/\d+$/);
    await expect(page.getByRole("heading", { name: "Hem", level: 1 })).toBeVisible();

    // The pier is the proof the walk is routed rather than guessed: it is a different
    // site, downhill, and a stop only a walking neighbourhood would offer.
    await expect(page.getByText("Nacka strand").first()).toBeVisible({ timeout: 120_000 });
    await expect(page.getByText(/\d+ min dit · \d+ min hem/).first()).toBeVisible();
    await expect(page.getByRole("application", { name: /Karta/ })).toBeVisible();

    const id = Number(page.url().split("/").pop());
    const hood = await request.get(`/api/places/${id}/neighbourhood`);
    expect(hood.status()).toBe(200);
    expect((await hood.json()).stops.length).toBeGreaterThanOrEqual(10);
  });

  test("plans a commute by saved label", async ({ request }) => {
    test.setTimeout(180_000);
    const id = await saveHome(request);

    const res = await request.get(`/api/commute?from=${SLUSSEN}&to=place:${id}`);
    expect(res.status()).toBe(200);
    const body = await res.json();
    // The label rides along beside the resolved place, so the UI can say "Hem" without
    // losing which stop that is.
    expect(body.toLabel).toBe("Hem");
    expect(body.fromLabel).toBeNull();
    expect(body.to.name).toBe("Jarlaberg");
    expect(body.options.length).toBeGreaterThan(0);
  });

  test("applies the stored walking settings", async ({ request }) => {
    test.setTimeout(180_000);
    const id = await saveHome(request);

    const saved = await request.put("/api/settings", { data: { maxWalkMinutes: 5 } });
    expect(saved.status()).toBe(200);
    expect((await saved.json()).settings).toMatchObject({ maxWalkMinutes: 5, speedKmh: 6 });

    // Five minutes from the Jarlaberg stop reaches Jarlaberg and not much else.
    const hood = await request.get(`/api/places/${id}/neighbourhood`);
    expect(hood.status()).toBe(200);
    const stops = (await hood.json()).stops as { name: string }[];
    expect(stops.map((s) => s.name)).toContain("Jarlaberg");
    expect(stops.length).toBeLessThanOrEqual(2);

    // The bare-coordinate read follows the same settings; the two must not disagree about
    // the same spot. A query override still wins for that one request.
    const byCoord = await request.get(`/api/neighbourhood?lat=59.31557&lon=18.16948`);
    expect(((await byCoord.json()).stops as unknown[]).length).toBeLessThanOrEqual(2);
    const widened = await request.get(`/api/neighbourhood?lat=59.31557&lon=18.16948&maxWalkMinutes=20`);
    expect(((await widened.json()).stops as unknown[]).length).toBeGreaterThan(10);

    // A shorter walk is still a walk: the trip planner keeps working on the one stop.
    const commute = await request.get(`/api/commute?from=${SLUSSEN}&to=place:${id}`);
    expect(commute.status()).toBe(200);
    expect((await commute.json()).options.length).toBeGreaterThan(0);

    const restored = await request.put("/api/settings", { data: { maxWalkMinutes: 20 } });
    expect((await restored.json()).settings.maxWalkMinutes).toBe(20);
  });

  test("renames and deletes a saved place", async ({ page, request }) => {
    const id = await saveHome(request);
    await page.goto(`/places/${id}`);

    await page.getByRole("button", { name: "Byt namn" }).click();
    await page.getByLabel("Namn").fill("Hemma");
    await page.getByLabel("Namn").press("Enter");
    await expect(page.getByRole("heading", { name: "Hemma", level: 1 })).toBeVisible();

    // Deleting asks in place rather than through window.confirm, which cannot be styled
    // and reads badly on a phone.
    await page.getByRole("button", { name: "Ta bort", exact: true }).click();
    await page.getByRole("button", { name: "Ta bort Hemma" }).click();
    await expect(page).toHaveURL(/\/places$/);

    expect((await request.get(`/api/places/${id}`)).status()).toBe(404);
  });
});

test.describe("the commute screen", () => {
  /** Two ends of the commute this whole engine was built around. */
  const JARLABERG = "9091001000004030";
  const SLUSSEN = "9091001000009192";

  let trip = "";
  let homeId = 0;

  test.beforeEach(async ({ request }) => {
    // The screen is about saved places, so it needs two before it means anything. The
    // neighbourhood behind them is routed live on first use, which is why these are the
    // slow tests in the suite.
    test.setTimeout(180_000);
    const work = await request.post("/api/places", {
      data: { label: "Jobbet", placeId: SLUSSEN },
    });
    const home = await request.post("/api/places", {
      data: { label: "Hem", placeId: JARLABERG },
    });
    expect(work.status()).toBe(201);
    expect(home.status()).toBe(201);
    const workId = (await work.json()).place.id as number;
    homeId = (await home.json()).place.id as number;
    trip = `/?from=place:${workId}&to=place:${homeId}`;
  });

  const sheet = (page: Page) => page.getByRole("region", { name: "Resor härifrån" });
  /** Nothing is fetched until asked: open the trip, then ask. */
  const open = async (page: Page, url = trip) => {
    await page.goto(url);
    await expect(sheet(page)).toContainText("Inget sökt än");
    await sheet(page).getByRole("button", { name: "Sök resor" }).click();
  };
  const rows = (page: Page) =>
    sheet(page).locator("ul > li").filter({ hasText: "Framme" });

  test("shows ranked options between two saved places", async ({ page }) => {
    await open(page);

    await expect(rows(page).first()).toBeVisible({ timeout: 120_000 });
    // Exactly one recommendation among the rows: two would be a contradiction, none
    // would leave the traveller to rank the list themselves.
    await expect(rows(page).getByText("Rekommenderad")).toHaveCount(1);
    // The whole decision is on the row: when to stand up, when the first ride leaves
    // and on what, and when you land.
    await expect(rows(page).first()).toContainText(/(Gå nu|\d+ min|Gå \d{2}:\d{2}|Gick \d{2}:\d{2})/);
    await expect(rows(page).first()).toContainText(/\d{2}:\d{2}.*→.*\d{2}:\d{2}/);
    await expect(rows(page).first()).toContainText(/Framme \d{2}:\d{2}/);
    // It is the one drawn until something else is chosen; nothing is open yet.
    await expect(rows(page).first().getByRole("button")).toHaveAttribute("aria-current", "true");
    await expect(page.getByRole("region", { name: "Vald resa" })).toHaveCount(0);
  });

  test("draws the option that was tapped", async ({ page }) => {
    const asked: string[] = [];
    page.on("request", (r) => {
      if (r.url().includes("/api/commute")) asked.push(r.url());
    });

    await open(page);
    await expect(rows(page).nth(1)).toBeVisible({ timeout: 120_000 });

    const second = rows(page).nth(1).getByRole("button").first();
    const label = (await second.innerText()).split("\n")[0];
    await second.click();
    // Tapping opens the trip, stop by stop, in place of the list.
    const trip = page.getByRole("region", { name: "Vald resa" });
    await expect(trip.locator("li").first()).toBeVisible();
    await expect(trip.getByRole("button", { name: "Fler val härifrån" }).first()).toBeVisible();
    // The geometry for a row that is not the recommended one is not in the first
    // response, so drawing it has to go and fetch it rather than draw nothing.
    await expect
      .poll(() => asked.some((url) => url.includes("paths=all")), { timeout: 30_000 })
      .toBe(true);
    // Back is the phone's Back: the list is as it was, with the opened trip still the
    // drawn one, and nothing was asked again.
    const before = asked.length;
    await page.goBack();
    await expect(rows(page).nth(1).getByRole("button")).toHaveAttribute("aria-current", "true");
    await expect(rows(page).nth(1)).toContainText(label!);
    expect(asked.length).toBe(before);
  });

  test("asks what else goes from a stop, by the stop's own id, and welds the pick on", async ({ page }) => {
    const asked: string[] = [];
    page.on("request", (r) => {
      if (r.url().includes("/api/commute")) asked.push(decodeURIComponent(r.url()));
    });
    await open(page);
    await rows(page).first().getByRole("button").click();
    const trip = page.getByRole("region", { name: "Vald resa" });
    const more = trip.getByRole("button", { name: "Fler val härifrån" }).first();
    await more.click();
    await expect(more).toHaveAttribute("aria-expanded", "true");
    // Planned from the stop by its journey-planner id, to the same saved place.
    await expect
      .poll(() => asked.find((u) => u.includes("from=9091") && u.includes(`to=place:${homeId}`)), { timeout: 60_000 })
      .toBeTruthy();
    const branches = trip.getByRole("list", { name: /^Resor från / });
    await expect(branches.locator("li").first()).toBeVisible({ timeout: 120_000 });
    // The ride already on the trip is marked as such and is not a choice.
    await expect(branches.getByText("Den här")).toHaveCount(1);
    // A board at a stop reads down the clock. Rendered text, not the DOM's: a branch
    // row hides the leave column it inherits from the list, and that carries a time.
    const departures = (await branches.locator("li").allInnerTexts()).map(
      (text) => /(\d{2}):(\d{2})/.exec(text)!,
    );
    const asMinutes = departures.map((m) => Number(m[1]) * 60 + Number(m[2]));
    expect(asMinutes).toEqual([...asMinutes].sort((a, b) => a - b));
    const other = branches.locator("li").filter({ hasNotText: "Den här" }).first();
    const arrival = (await other.textContent())!.match(/Framme (\d{2}:\d{2})/)![1];
    await other.getByRole("button").click();
    // The pick is now the opened trip: same header shape, its own arrival time.
    await expect(trip).toContainText(`framme ${arrival}`);
    await expect(trip.getByRole("button", { name: "Fler val härifrån" }).first()).toBeVisible();
  });

  test("says on the map which line to board, and when", async ({ page }) => {
    await open(page);
    await expect(rows(page).first()).toBeVisible({ timeout: 120_000 });
    // The boarding callout carries the line and a clock time; the alighting one a time
    // and the stop name. Both live in the map, not the sheet.
    const callouts = page.locator(".maplibregl-marker").filter({ hasText: /\d{2}:\d{2}/ });
    await expect(callouts.first()).toBeVisible();
    expect(await callouts.count()).toBeGreaterThanOrEqual(2);
    // The badge's text is the designation followed by its screen-reader label.
    const badge = await rows(page).first().locator("[style*='background-color']").first().innerText();
    const designation = badge.trim().split("\n")[0]!;
    await expect(callouts.filter({ hasText: designation }).first()).toBeVisible();
  });

  test("draws the departure's own vehicle when the server knows it, else the line", async ({ page }) => {
    // The local server has no Trafiklab key, so the stream is played back. The server
    // decides the match; the map shows the one vehicle large, or the line's small.
    let line = "";
    let match: "trip" | "line" = "line";
    const asked: string[] = [];
    await page.route("**/api/vehicles/stream*", (route) => {
      asked.push(decodeURIComponent(route.request().url()));
      const vehicle = (id: string, l: string, lat = 59.31, lon = 18.12) =>
        `{"id":"${id}","lat":${lat},"lon":${lon},"bearing":90,"speed":null,"mode":"BUS","line":"${l}","tripId":"t-${id}","destination":null,"directionId":null,"timestamp":null}`;
      const crowd = Array.from({ length: 150 }, (_, i) =>
        vehicle(`c${i}`, "999", 59.28 + (i % 15) * 0.006, 18.02 + Math.floor(i / 15) * 0.014),
      );
      const mine = match === "trip" ? [vehicle("a", line)] : [vehicle("a", line), vehicle("b", line, 59.32, 18.10)];
      route.fulfill({
        status: 200,
        contentType: "text/event-stream",
        body: `event: vehicles\ndata: {"vehicles":[${[...mine, ...crowd].join(",")}],"fetchedAt":"2026-01-01T00:00:00Z","available":true,"reason":null,"match":"${match}"}\n\n`,
      });
    });
    await open(page);
    await expect(rows(page).first()).toBeVisible({ timeout: 120_000 });
    const badge = await rows(page).first().locator("[style*='background-color']").first().innerText();
    line = badge.trim().split("\n")[0]!;

    // The stream is asked with the departure, not just the area.
    await expect.poll(() => asked.some((u) => u.includes("trip=") && u.includes("boardAt=") && u.includes(`line=${line}`))).toBe(true);

    // Line match: both vehicles on the line as small pills, none of the crowd.
    const pills = page.locator(".maplibregl-marker.vehicle");
    await expect(pills.filter({ hasText: line })).toHaveCount(2, { timeout: 30_000 });
    await expect(pills.filter({ hasText: "999" })).toHaveCount(0);
    await expect(page.locator(".vehicle-exact")).toHaveCount(0);

    // Trip match: the one vehicle, large.
    match = "trip";
    await expect(page.locator(".vehicle-exact").filter({ hasText: line })).toHaveCount(1, { timeout: 30_000 });
    await page.waitForTimeout(1000);
    await page.screenshot({ path: ".e2e/explore/commute-vehicles.png" });
  });

  test("keeps from and to in the URL and swaps them", async ({ page }) => {
    await page.goto(trip);
    const from = page.getByRole("button", { name: /^Från/ });
    await expect(from).toContainText("Jobbet");

    await page.getByRole("button", { name: /byt plats/i }).click();

    await expect(page).toHaveURL(new RegExp(`from=place%3A${homeId}`));
    await expect(from).toContainText("Hem");
    await expect(page.getByRole("button", { name: /^Till/ })).toContainText("Jobbet");
  });

  test("picks a place from the chip picker, and Back closes it", async ({ page }) => {
    await page.goto(trip);
    await page.getByRole("button", { name: /^Från/ }).click();

    const picker = page.getByRole("dialog", { name: "Var börjar du?" });
    await expect(picker).toBeVisible();

    // An overlay that Back does not close is a trap on a phone, where Back is a gesture.
    await page.goBack();
    await expect(picker).toBeHidden();

    await page.getByRole("button", { name: /^Från/ }).click();
    await page.getByRole("dialog").getByRole("option", { name: /Hem/ }).click();
    await expect(page).toHaveURL(new RegExp(`from=place%3A${homeId}`));
  });

  test("the picker offers the saved places first, in both themes", async ({ page }) => {
    for (const scheme of ["dark", "light"] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      await page.goto(trip);
      await page.getByRole("button", { name: /^Till/ }).click();
      const picker = page.getByRole("dialog", { name: "Vart ska du?" });
      await expect(picker.getByRole("option", { name: /Hem/ })).toBeVisible();
      // Position, then the saved places: the answer before the keyboard.
      const names = await picker.getByRole("option").allInnerTexts();
      expect(names[0]).toContain("Min position");
      expect(names.join(" ")).toContain("Hem");
      await page.screenshot({ path: `.e2e/explore/picker-${scheme}.png` });
      await page.goBack();
    }
  });

  test("plans around a chosen time, keeps it in the URL, and Nu clears it", async ({ page }) => {
    await page.goto(trip);
    const pill = page.getByRole("button", { name: /^Nu$|^Avgång|^Framme senast/ });
    await expect(pill).toHaveText("Nu");

    await pill.click();
    const picker = page.getByRole("dialog", { name: "Välj tid" });
    await expect(picker).toBeVisible();
    await picker.getByRole("button", { name: "Framme senast" }).click();
    await picker.getByLabel("Senast framme").fill(localTomorrowAt(17, 0));
    await picker.getByRole("button", { name: "Klar" }).click();

    await expect(page).toHaveURL(/arriveBy=1/);
    await expect(page).toHaveURL(/when=/);
    await expect(pill).toHaveText("Framme senast imorgon 17:00");

    // Every row answers the question asked: on the ground before five.
    await expect(rows(page).first()).toBeVisible({ timeout: 120_000 });
    const arrivals = await rows(page).locator("text=/Framme \\d{2}:\\d{2}/").allTextContents();
    expect(arrivals.length).toBeGreaterThan(0);
    for (const text of arrivals) {
      const [h, m] = /Framme (\d{2}):(\d{2})/.exec(text)!.slice(1).map(Number);
      expect(h! * 60 + m!).toBeLessThanOrEqual(17 * 60);
    }

    // Nu is the way back to the ordinary screen, and the URL forgets the time with it.
    await pill.click();
    await picker.getByRole("button", { name: "Nu" }).click();
    await expect(page).toHaveURL(/^(?!.*when=).*$/);
    await expect(pill).toHaveText("Nu");
  });

  test("the sheet tucks to its handle and a tap brings it back", async ({ page }) => {
    await open(page);
    await expect(rows(page).first()).toBeVisible({ timeout: 120_000 });
    const handle = sheet(page).getByRole("button", { name: /Visa fler resor/ });
    const box = (await handle.boundingBox())!;
    const before = (await sheet(page).boundingBox())!.height;

    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2, box.y + 400, { steps: 8 });
    await page.mouse.up();

    await expect.poll(async () => (await sheet(page).boundingBox())!.height).toBeLessThan(48);
    expect(before).toBeGreaterThan(200);
    await sheet(page).getByRole("button", { name: "Visa resor" }).click();
    await expect.poll(async () => (await sheet(page).boundingBox())!.height).toBeGreaterThan(200);
  });

  test("Tidigare moves the planning time back ten minutes and Back undoes it", async ({ page }) => {
    await open(page);
    await expect(rows(page).first()).toBeVisible({ timeout: 120_000 });
    const firstBefore = await rows(page).first().innerText();
    const countBefore = await rows(page).count();
    await page.getByRole("button", { name: "Tidigare" }).click();
    // Read after the click: the button sits under the whole list, and scrolling to it
    // takes long enough to eat into a "ten minutes before the click" measured before.
    const clicked = Date.now();
    await expect(page).toHaveURL(/when=/);
    // Asking for earlier adds to the list; what was on screen stays on screen.
    await expect(rows(page).filter({ hasText: firstBefore.split("\n")[0]! }).first()).toBeVisible();
    await expect.poll(() => rows(page).count(), { timeout: 60_000 }).toBeGreaterThanOrEqual(countBefore);
    const when = new URL(page.url()).searchParams.get("when")!;
    const shift = clicked - new Date(when).getTime();
    expect(shift).toBeGreaterThanOrEqual(10 * 60_000);
    expect(shift).toBeLessThan(11 * 60_000);
    await expect(page.getByRole("button", { name: /^Avgång/ })).toBeVisible();
    // Still answering: the rows planned from ten minutes ago include what is live now.
    await expect(rows(page).first()).toBeVisible({ timeout: 60_000 });

    await page.goBack();
    await expect(page).toHaveURL(/^(?!.*when=).*$/);
  });

  test("refreshing plans from where the phone is now, not where it was", async ({ page, context }) => {
    await context.grantPermissions(["geolocation"]);
    // Slussen first, then Jarlaberg: the same commute, from the other end.
    await context.setGeolocation({ latitude: 59.3196, longitude: 18.0722 });
    const asked: string[] = [];
    page.on("request", (r) => {
      if (r.url().includes("/api/commute")) asked.push(decodeURIComponent(r.url()));
    });

    await open(page, `/?from=me&to=place:${homeId}`);
    await expect.poll(() => asked.some((u) => u.includes("from=59.3196,18.0722")), { timeout: 120_000 }).toBe(true);
    await expect(rows(page).first()).toBeVisible({ timeout: 120_000 });

    await context.setGeolocation({ latitude: 59.31557, longitude: 18.16948 });
    await page.getByRole("button", { name: "Uppdatera" }).click();
    await expect.poll(() => asked.some((u) => u.includes("from=59.31557,18.16948")), { timeout: 60_000 }).toBe(true);
    // The rows were replaced in place; no skeleton pass in between.
    await expect(rows(page).first()).toBeVisible();
  });

  test("survives an API outage without a white screen", async ({ page }) => {
    await page.route("**/api/commute*", (route) =>
      route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({ error: { code: "boom", message: "Kunde inte hämta resor." } }),
      }),
    );
    await open(page);

    await expect(page.getByRole("button", { name: "Försök igen" })).toBeVisible();
    expect((await page.locator("body").innerText()).trim().length).toBeGreaterThan(20);
  });

  test("looks right in both themes", async ({ page }) => {
    // Not asserted: a screenshot is for a human to look at. It fails only if the screen
    // cannot be reached at all, which is worth knowing on its own.
    for (const scheme of ["dark", "light"] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      await open(page);
      await expect(rows(page).first()).toBeVisible({ timeout: 120_000 });
      // The basemap tiles settle a beat after the rows do.
      await page.waitForTimeout(3000);
      await page.screenshot({ path: `.e2e/explore/commute-${scheme}.png` });
    }
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
    for (const path of ["/", "/plan"]) {
      await page.goto(path);
      const small = await page.evaluate(() =>
        [...document.querySelectorAll("button, a[href], input, [role=tab]")]
          .filter((el) => {
            const r = el.getBoundingClientRect();
            return r.width > 0 && r.height > 0 && r.height < 44;
          })
          .map((el) => `${el.tagName} h=${Math.round(el.getBoundingClientRect().height)}`),
      );
      expect(small, path).toEqual([]);
    }
  });

  /**
   * The regression: a phone kept a tab alive for two hours across a deploy, so it went
   * on running the build that redrew sixteen hundred vehicles every four seconds and
   * reported the bug that deploy had fixed. `index.html` is `no-cache`, so a reload was
   * always the cure; nothing ever asked for one.
   */
  const isAppShellCheck = (url: URL) => url.pathname === "/";

  test("a tab whose build is still the current one says nothing", async ({ page }) => {
    await page.goto("/");
    const checked = page.waitForResponse(
      (r) => isAppShellCheck(new URL(r.url())) && r.request().resourceType() === "fetch",
    );
    await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
    await checked;
    await expect(page.getByRole("button", { name: "Ny version, ladda om" })).toBeHidden();
  });

  test("a tab left open across a deploy offers the reload", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("navigation", { name: "Huvudmeny" })).toBeVisible();

    // Only the app's own check is answered with a newer shell; the navigation that got
    // us here has already happened and must not be rewritten under it.
    await page.route(isAppShellCheck, async (route) => {
      if (route.request().resourceType() !== "fetch") return route.continue();
      const res = await route.fetch();
      const shipped = (await res.text()).replace(/index-[^.]+\.js/, "index-adifferentbuild.js");
      await route.fulfill({ response: res, body: shipped });
    });

    await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
    await expect(page.getByRole("button", { name: "Ny version, ladda om" })).toBeVisible();
  });

  /**
   * The regression: the basemap licence was pinned to the tab bar plus a hard 188 px,
   * which is the sheet at one of its four heights. At any other height it floated in
   * open map with nothing under it, reading as a stray button rather than a credit.
   */
  test("the map's licence hugs the sheet at whatever height the sheet is", async ({ page }) => {
    await page.goto("/");
    const sheet = page.getByRole("region", { name: "Resor härifrån" });
    const licence = page.locator(".commute-map .maplibregl-ctrl-bottom-right");
    await expect(sheet).toBeVisible();
    await expect(licence).toBeVisible();

    /** Pixels of open map between the licence and the top of the sheet. */
    const gap = async () => {
      const [s, l] = [await sheet.boundingBox(), await licence.boundingBox()];
      return Math.round(s!.y - (l!.y + l!.height));
    };
    // Polled, because both slide when the sheet changes height.
    const hugsTheSheet = async () => {
      await expect.poll(gap).toBeLessThan(60);
      expect(await gap(), "the licence must sit above the sheet, not under it").toBeGreaterThanOrEqual(-1);
    };

    await hugsTheSheet();

    // A tap on the handle grows the sheet; the licence has to come up with it.
    const before = (await licence.boundingBox())!.y;
    await page.getByRole("button", { name: "Visa fler resor" }).click();
    await expect.poll(async () => (await licence.boundingBox())!.y).toBeLessThan(before);
    await hugsTheSheet();
  });

  test("the planner survives an API outage without a white screen", async ({ page }) => {
    await page.route("**/api/journeys*", (route) => route.abort());
    await page.goto("/plan?from=9091001000009189&to=9091001000009001");
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
    await expect(page.getByRole("button", { name: "Logga in med Google" })).toBeVisible();
    // No email field, no password: an invite is the only way to a new account.
    await expect(page.getByText(/Ny här\?/)).toBeVisible();
    await context.close();
  });

  test("signs in through a CLI invite link and reaches the app", async ({ browser }) => {
    const context = await browser.newContext();
    const page = await context.newPage();

    await followInvite(page, mintInvite(uniqueEmail()));
    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByRole("button", { name: /^Från/ })).toBeVisible();

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
    await page.getByRole("button", { name: "Fortsätt" }).click();
    await expect(page.getByText("Inbjudningslänken har redan använts eller gått ut. Be om en ny.")).toBeVisible();
    // Shown the message and not signed in, which is the part that matters.
    expect((await page.request.get("/api/me")).status()).toBe(401);
    await second.close();
  });

  test("survives being fetched before it is accepted", async ({ browser, playwright, baseURL }) => {
    // Chat apps and mail clients fetch every link they show to build a preview. A link
    // that is spent by that fetch never reaches the person it was for. One-time means
    // accepted once, not fetched once.
    const url = mintInvite(uniqueEmail());
    const previewer = await playwright.request.newContext({ baseURL });
    for (let i = 0; i < 3; i += 1) {
      const res = await previewer.get(url);
      expect(res.status()).toBe(200);
      expect(res.headers()["set-cookie"] ?? "").not.toContain("session_token");
    }
    await previewer.dispose();

    const context = await browser.newContext();
    await followInvite(await context.newPage(), url);
    await context.close();
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

  test("drops a spent invite from the inviter's list", async ({ request, playwright, baseURL }) => {
    // Better Auth consumes the link's token silently; the list has to notice, because a
    // link that only answers "already used" is not something worth resending.
    const created = await request.post("/api/invites", { data: { email: uniqueEmail() } });
    expect(created.status()).toBe(201);
    const { url } = (await created.json()) as { url: string };
    const before = (await (await request.get("/api/invites")).json()) as { invites: { url: string }[] };
    expect(before.invites.map((i) => i.url)).toContain(url);

    const invited = await playwright.request.newContext({ baseURL });
    expect((await invited.get(verifyUrlOf(url), { maxRedirects: 0 })).status()).toBe(302);
    await invited.dispose();

    const after = (await (await request.get("/api/invites")).json()) as { invites: { url: string }[] };
    expect(after.invites.map((i) => i.url)).not.toContain(url);
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

  test("an API key over its rate limit gets a 429, not a 401", async ({ request, playwright, baseURL }) => {
    test.setTimeout(120_000);
    // The api-key plugin throws for both an unknown key and an exhausted one; the gate has
    // to tell them apart, or an agent that is merely too fast is told its key is bad.
    const created = await request.post("/api/auth/api-key/create", {
      data: { name: "e2e-rate" },
      headers: { origin: baseURL! },
    });
    const key = (await created.json()).key as string;
    const agent = await playwright.request.newContext({ baseURL, extraHTTPHeaders: { "x-api-key": key } });
    let last = 0;
    for (let i = 0; i < 125 && last !== 429; i++) {
      last = (await agent.get("/api/me")).status();
      expect([200, 429]).toContain(last);
    }
    expect(last).toBe(429);
    const refused = await agent.get("/api/me");
    expect(refused.status()).toBe(429);
    expect((await refused.json()).error.code).toBe("rate_limited");
    await agent.dispose();
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
    expect(url).toContain("/invite#token=");

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

  test("sends a Google sign-in to Google with this instance as the return address", async ({
    browser,
  }) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    // Google itself is out of reach for a test; what can be checked is that the button
    // starts the OAuth dance towards accounts.google.com with our callback in it.
    const toGoogle = page.waitForRequest((req) => req.url().startsWith("https://accounts.google.com/"));
    await page.route("https://accounts.google.com/**", (route) => route.abort());
    await page.goto("/signin");
    await page.getByRole("button", { name: "Logga in med Google" }).click();
    const url = new URL((await toGoogle).url());
    expect(url.searchParams.get("client_id")).toBe("e2e-google-client-id.apps.googleusercontent.com");
    expect(url.searchParams.get("redirect_uri")).toBe("http://localhost:3111/api/auth/callback/google");
    await context.close();
  });

  test("explains a Google sign-in for an address nobody invited", async ({ browser }) => {
    // The refusal itself happens inside Better Auth's callback, which sends the browser
    // back here with the code the create hook threw. The words are what a person sees.
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto("/signin?error=NOT_INVITED");
    await expect(page.getByRole("alert")).toContainText("Ingen inbjudan finns för den här adressen");
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
