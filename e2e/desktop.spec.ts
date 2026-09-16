import { expect, test, type Page } from "@playwright/test";
import { signInContext } from "./auth";

/**
 * The desktop layout, at 1440 x 900. Only what differs from the phone is here: the
 * screens, the data and the names are the same code, and smoke.spec.ts drives those.
 */

test.beforeEach(async ({ context, request }) => {
  await signInContext(context, request);
});

const nav = (page: Page) => page.getByRole("navigation", { name: "Huvudmeny" });

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
    const sheet = page.getByRole("region", { name: "Resor härifrån" });
    await expect(sheet).toBeVisible();
    expect((await sheet.boundingBox())!.x).toBeGreaterThanOrEqual(76);
    expect((await tripEnd(page, "Från").boundingBox())!.x).toBeGreaterThanOrEqual(76);
    // With no bar along the bottom, the sheet sits on the bottom edge.
    const box = (await sheet.boundingBox())!;
    expect(Math.round(box.y + box.height)).toBe(900);

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

const tripEnd = (page: Page, end: "Från" | "Till") =>
  page.getByRole("button", { name: new RegExp(`^${end}`) });
