import { expect, test, type Locator, type Page } from "@playwright/test";
import { signInContext } from "./auth";

/**
 * The desktop layout, at 1440 x 900. Only what differs from the phone is here: the
 * screens, the data and the names are the same code, and smoke.spec.ts drives those.
 */

test.beforeEach(async ({ context, request }) => {
  await signInContext(context, request);
});

const nav = (page: Page) => page.getByRole("navigation", { name: "Huvudmeny" });
const panel = (page: Page) => page.getByRole("region", { name: "Resor härifrån" });
const tripEnd = (page: Page, end: "Från" | "Till") =>
  page.getByRole("button", { name: new RegExp(`^${end}`) });

test.describe("the rail", () => {
  test("runs down the left edge instead of along the bottom", async ({ page }) => {
    await page.goto("/");
    const box = (await nav(page).boundingBox())!;
    expect(box.x).toBe(0);
    expect(box.y).toBe(0);
    expect(box.width).toBe(76);
    expect(box.height).toBe(900);

    // The four places stack from the top, in the phone's order.
    const links = nav(page).getByRole("link");
    await expect(links).toHaveText([/^Res/, /^Nära/, /^Trafikläget/, /^Mer/]);
    const first = (await links.first().boundingBox())!;
    const second = (await links.nth(1).boundingBox())!;
    expect(second.y).toBeGreaterThan(first.y + first.height - 1);
    expect(second.x).toBeCloseTo(first.x, 0);
  });

  test("moves between surfaces and marks where you are", async ({ page }) => {
    await page.goto("/");
    await expect(nav(page).getByRole("link", { name: /^Res/ })).toContainText("(aktuell sida)");
    await nav(page).getByRole("link", { name: /^Trafikläget/ }).click();
    await expect(page).toHaveURL(/\/disruptions$/);
    await expect(nav(page).getByRole("link", { name: /^Trafikläget/ })).toContainText("(aktuell sida)");
    await nav(page).getByRole("link", { name: /^Nära/ }).click();
    await expect(page).toHaveURL(/\/nearby$/);
  });

  test("covers nothing on any screen", async ({ page }) => {
    // The commute screen is fixed to the viewport rather than laid out in the page, so it
    // is the one that can slide under the rail; the rest are checked through their heading.
    await page.goto("/");
    await expect(panel(page)).toBeVisible();
    expect((await panel(page).boundingBox())!.x).toBeGreaterThanOrEqual(76);

    for (const path of ["/nearby", "/disruptions", "/settings", "/places"]) {
      await page.goto(path);
      const heading = page.getByRole("heading", { level: 1 });
      await expect(heading, path).toBeVisible();
      expect((await heading.boundingBox())!.x, path).toBeGreaterThanOrEqual(76);
    }
  });

  test("is not on the sign-in page", async ({ browser }) => {
    const signedOut = await browser.newPage();
    await signedOut.goto("/signin");
    await expect(signedOut.getByRole("button", { name: /Google/ })).toBeVisible();
    await expect(nav(signedOut)).toHaveCount(0);
    await signedOut.close();
  });
});

test("every target clears 44 px", async ({ page }) => {
  for (const path of ["/", "/plan", "/nearby", "/disruptions", "/settings"]) {
    await page.goto(path);
    await expect(nav(page)).toBeVisible();
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


test.describe("the commute panel", () => {
  const JARLABERG = "9091001000004030";
  const SLUSSEN = "9091001000009192";
  let trip = "";

  test.beforeEach(async ({ request }) => {
    test.setTimeout(180_000);
    const work = await request.post("/api/places", { data: { label: "Jobbet", placeId: SLUSSEN } });
    const home = await request.post("/api/places", { data: { label: "Hem", placeId: JARLABERG } });
    expect(work.status()).toBe(201);
    expect(home.status()).toBe(201);
    trip = `/?from=place:${(await work.json()).place.id}&to=place:${(await home.json()).place.id}`;
  });

  const rows = (page: Page) => panel(page).locator("ul > li").filter({ hasText: "Framme" });

  test("floats beside the rail with the trip controls inside it, and no sheet", async ({ page }) => {
    await page.goto(trip);
    await expect(panel(page)).toContainText("Inget sökt än");
    // The controls are part of the panel rather than floating over the map on their own.
    await expect(panel(page).getByRole("button", { name: /^Till/ })).toBeVisible();
    await expect(page.getByRole("button", { name: "Visa fler resor" })).toHaveCount(0);

    const card = (await panel(page).getByRole("button", { name: /^Från/ }).boundingBox())!;
    expect(card.x).toBeGreaterThanOrEqual(88);
    expect(card.x + card.width).toBeLessThanOrEqual(88 + 408);
    expect(card.y).toBeLessThan(40);

    // Unasked, the panel is as tall as what it holds, and the map shows under the rest.
    const button = (await panel(page).getByRole("button", { name: "Sök resor" }).boundingBox())!;
    expect(button.y + button.height).toBeLessThan(450);
  });

  test("lists the trips in the panel, scrolling inside it, and opens one in place", async ({ page }) => {
    await page.goto(trip);
    await panel(page).getByRole("button", { name: "Sök resor" }).click();
    await expect(rows(page).nth(1)).toBeVisible({ timeout: 120_000 });

    // However many trips come back, the panel stops at the bottom of the screen.
    const later = panel(page).getByRole("button", { name: "Senare" });
    await later.scrollIntoViewIfNeeded();
    await expect(later).toBeInViewport();
    expect((await page.evaluate(() => document.scrollingElement!.scrollTop))).toBe(0);

    // Found by its arrival rather than its index: the live list can gain or drop a trip
    // at the top while this one is open.
    const row = rows(page).nth(1).getByRole("button").first();
    const arrival = (await row.locator("> span").last().textContent())!;
    await row.click();
    const opened = page.getByRole("region", { name: "Vald resa" });
    await expect(opened.locator("li").first()).toBeVisible();
    await page.goBack();
    await expect(panel(page).locator('[aria-current="true"]')).toHaveCount(1);
    await expect(panel(page).locator('[aria-current="true"] > span').last()).toHaveText(arrival);
  });

  test("keeps the map's zoom and licence in its own corners", async ({ page }) => {
    await page.goto(trip);
    const zoom = page.locator(".commute-map .maplibregl-ctrl-top-right");
    const licence = page.locator(".commute-map .maplibregl-ctrl-bottom-right");
    await expect(zoom).toBeVisible();
    await expect(licence).toBeVisible();
    expect((await zoom.boundingBox())!.y).toBeLessThan(20);
    const box = (await licence.boundingBox())!;
    expect(box.y + box.height).toBeGreaterThan(880);
  });
});

test("a tablet keeps the sheet, at a width that leaves the map beside it", async ({ page }) => {
  await page.setViewportSize({ width: 800, height: 1000 });
  await page.goto("/");
  await expect(panel(page)).toBeVisible();
  // The phone's sheet, with its handle, and the tab bar back along the bottom.
  await expect(page.getByRole("button", { name: "Visa fler resor" })).toBeVisible();
  const sheet = (await panel(page).boundingBox())!;
  expect(sheet.x).toBe(0);
  expect(sheet.width).toBe(480);
  const bar = (await nav(page).boundingBox())!;
  expect(bar.width).toBe(800);
  expect(Math.round(bar.y + bar.height)).toBe(1000);
});

test.describe("pickers", () => {
  /** The popover's box against the control that opened it. */
  const under = async (popover: Locator, control: Locator) => {
    const [p, c] = [(await popover.boundingBox())!, (await control.boundingBox())!];
    expect(p.y).toBeGreaterThan(c.y + c.height);
    expect(p.y).toBeLessThan(c.y + c.height + 20);
    expect(Math.abs(p.x - c.x)).toBeLessThan(2);
  };

  test("the place search opens under the trip control, and a click outside closes it", async ({ page }) => {
    await page.goto("/");
    await tripEnd(page, "Till").click();
    const search = page.getByRole("dialog", { name: "Vart ska du?" });
    await expect(search.getByRole("combobox")).toBeVisible();
    await under(search, page.locator('[data-popover-anchor="ends"]'));

    // The map stays readable behind it: no dimmed backdrop.
    const backdrop = await search.evaluate((el) => getComputedStyle(el, "::backdrop").backgroundColor);
    expect(backdrop).toBe("rgba(0, 0, 0, 0)");

    await page.mouse.click(1200, 600);
    await expect(search).toBeHidden();
    await expect(page).toHaveURL(/\/$/);
  });

  test("Back closes a popover, like it does the phone's full screen", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("button", { name: /^Nu/ }).click();
    const picker = page.getByRole("dialog", { name: "Välj tid" });
    await expect(picker).toBeVisible();
    await under(picker, page.locator('[data-popover-anchor="time"]'));
    await page.goBack();
    await expect(picker).toBeHidden();
    await expect(page.getByRole("region", { name: "Resor härifrån" })).toBeVisible();
  });

  test("the mode filter opens under its pill and Escape closes it", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("button", { name: "Färdmedel" }).click();
    const picker = page.getByRole("dialog", { name: "Välj färdmedel" });
    await expect(picker).toBeVisible();
    await under(picker, page.locator('[data-popover-anchor="modes"]'));
    await page.keyboard.press("Escape");
    await expect(picker).toBeHidden();
  });

  test("a popover works from the keyboard, without closing on the keys that click", async ({ page }) => {
    // Enter and Space click at 0,0, which is outside the popover's box.
    await page.goto("/");
    await page.getByRole("button", { name: "Färdmedel" }).click();
    const picker = page.getByRole("dialog", { name: "Välj färdmedel" });
    const first = picker.getByRole("checkbox").first();
    const was = await first.isChecked();
    await first.focus();
    await page.keyboard.press("Space");
    await expect(picker).toBeVisible();
    await expect(first).toBeChecked({ checked: !was });

    await picker.getByRole("button", { name: "Klar" }).focus();
    await page.keyboard.press("Enter");
    await expect(picker).toBeHidden();
    // The pill now names what was picked, so it is found by where the popover hangs.
    await page.locator('[data-popover-anchor="modes"]').click();
    await expect(picker.getByRole("checkbox").first()).toBeChecked({ checked: !was });
  });
});
