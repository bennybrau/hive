// Run by scripts/test-dashboard-e2e.sh inside the Playwright image; not part of vitest or tsc.
import { expect, test } from "@playwright/test";

const HIVE = process.env.HIVE_URL ?? "http://127.0.0.1:8800";
const MEMBER = process.env.HIVE_E2E_TOKEN ?? "";
const CURATOR = process.env.HIVE_E2E_CURATOR_TOKEN ?? "";

test("a curator opens Stats and sees cost, facts, workers and backlog", async ({ page }) => {
  expect(CURATOR, "HIVE_E2E_CURATOR_TOKEN is not set").not.toBe("");
  await page.goto(`${HIVE}/`);
  await page.getByLabel("Token").fill(CURATOR);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/facts$/);
  await page.getByRole("link", { name: "Stats" }).click();
  await expect(page).toHaveURL(/\/stats$/);

  for (const name of ["Cost", "Facts", "Workers", "Backlog"]) {
    await expect(page.getByRole("heading", { name, exact: true })).toBeVisible();
  }
  await expect(page.getByRole("table", { name: "Status" })).toBeVisible();
  await expect(page.getByRole("table", { name: "Backlog" })).toBeVisible();

  const seven = page.getByRole("button", { name: "7 days" });
  const stats = page.waitForResponse((r) => r.url().includes("/v1/stats?days=7") && r.status() === 200);
  await seven.click();
  await stats;
  await expect(seven).toHaveAttribute("aria-pressed", "true");
});

test("a member sees no Stats link and a curators-only note at /stats", async ({ page }) => {
  expect(MEMBER, "HIVE_E2E_TOKEN is not set").not.toBe("");
  await page.goto(`${HIVE}/`);
  await page.getByLabel("Token").fill(MEMBER);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/facts$/);
  await expect(page.getByRole("link", { name: "Stats" })).toHaveCount(0);
  await page.evaluate(() => {
    history.pushState(null, "", "/stats");
    dispatchEvent(new PopStateEvent("popstate"));
  });
  await expect(page.getByRole("note")).toContainText("curators only");
});
