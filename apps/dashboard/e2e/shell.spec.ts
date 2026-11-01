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
  await expect(page).toHaveURL(/\/facts$/);
  await expect(page.getByLabel("role")).toHaveText("member");
  await expect(page.getByRole("heading", { name: "Facts" })).toBeVisible();

  // The hive serves index.html for client routes, and the token survives a reload of the tab.
  await page.reload();
  await expect(page.getByLabel("role")).toHaveText("member");

  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page.getByLabel("Token")).toBeVisible();
  expect(await page.evaluate(() => sessionStorage.getItem("hive.token"))).toBeNull();
});
