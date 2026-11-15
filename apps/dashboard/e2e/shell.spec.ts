// Run by scripts/test-dashboard-e2e.sh inside the Playwright image; not part of vitest or tsc.
import { expect, test } from "@playwright/test";

const HIVE = process.env.HIVE_URL ?? "http://127.0.0.1:8800";
const TOKEN = process.env.HIVE_E2E_TOKEN ?? "";

test("sign in, see the role, sign out", async ({ page }) => {
  expect(TOKEN, "HIVE_E2E_TOKEN is not set").not.toBe("");
  await page.goto(`${HIVE}/`);

  await page.getByLabel("Token").fill("hive_not-a-real-token");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("alert")).toContainText("didn't accept");

  await page.getByLabel("Token").fill(TOKEN);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("navigation", { name: "Main" })).toBeVisible();
  await expect(page).toHaveURL(/:\/\/[^/]+\/$/);
  await expect(page.getByLabel("role")).toHaveText("Member");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(/^Good (morning|afternoon|evening), /);

  // The hive serves index.html for client routes, and the token survives a reload of the tab.
  await page.reload();
  await expect(page.getByLabel("role")).toHaveText("Member");

  await page.getByText("Member", { exact: true }).click(); // opens the account panel
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page.getByLabel("Token")).toBeVisible();
  expect(await page.evaluate(() => sessionStorage.getItem("hive.token"))).toBeNull();
});

const CURATOR = process.env.HIVE_E2E_CURATOR_TOKEN ?? "";

test("on a phone no page is wider than the screen, and the menu opens from the top bar", async ({ browser }) => {
  expect(CURATOR, "HIVE_E2E_CURATOR_TOKEN is not set").not.toBe("");
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const page = await context.newPage();
  await page.goto(`${HIVE}/`);
  await page.getByLabel("Token").fill(CURATOR);
  await page.getByRole("button", { name: "Sign in" }).tap();
  await page.getByRole("button", { name: "Menu" }).tap(); // on a phone the menu sits behind the Menu button
  await expect(page.getByRole("navigation", { name: "Main" })).toBeVisible();
  await expect(page).toHaveURL(/:\/\/[^/]+\/$/);
  await page.getByRole("button", { name: "Close" }).tap();

  for (const path of ["/", "/facts", "/search", "/review", "/stale", "/playbooks", "/teams", "/repos", "/stats", "/settings"]) {
    await page.evaluate((p) => {
      history.pushState(null, "", p);
      dispatchEvent(new PopStateEvent("popstate"));
    }, path);
    await page.waitForLoadState("networkidle");
    expect(await page.evaluate(() => document.documentElement.scrollWidth), `${path} scrolls sideways`).toBeLessThanOrEqual(390);
  }

  const menu = page.getByRole("button", { name: "Menu" });
  await expect(menu).toHaveAttribute("aria-expanded", "false");
  await menu.tap();
  await expect(page.getByRole("button", { name: "Close" })).toHaveAttribute("aria-expanded", "true");
  await page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Teams" }).tap();
  await expect(page).toHaveURL(/\/teams$/);
  await expect(page.getByRole("navigation", { name: "Main" })).toBeHidden();
  await context.close();
});
