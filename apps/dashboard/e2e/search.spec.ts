// Run by scripts/test-dashboard-e2e.sh inside the Playwright image; not part of vitest or tsc.
import { expect, test } from "@playwright/test";

const HIVE = process.env.HIVE_URL ?? "http://127.0.0.1:8800";
const TOKEN = process.env.HIVE_E2E_TOKEN ?? "";

test("search finds a fresh personal fact and opens it", async ({ page }) => {
  expect(TOKEN, "HIVE_E2E_TOKEN is not set").not.toBe("");
  const marker = `zs${Date.now()}`;
  const text = `Dashboard search e2e fact ${marker}: search covers facts and docs together.`;
  const res = await page.request.post(`${HIVE}/v1/facts`, {
    headers: { authorization: `Bearer ${TOKEN}` },
    data: { text, kind: "gotcha", scope: "personal" },
  });
  expect(res.status()).toBe(201);

  await page.goto(`${HIVE}/`);
  await page.getByLabel("Token").fill(TOKEN);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/facts$/);

  await page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Search" }).click();
  await expect(page).toHaveURL(/\/search$/);
  await page.getByRole("button", { name: "Docs" }).click();
  await expect(page).toHaveURL(/source=fact%2Cconversation%2Chistory%2Ccommit$/);
  await page.getByLabel("Search").fill(marker);
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await expect(page).toHaveURL(/q=zs\d+/);

  await page.getByRole("region", { name: "Facts" }).getByRole("link", { name: text }).click();
  await expect(page).toHaveURL(/\/facts\/[0-9a-f-]+$/);
  await expect(page.getByRole("complementary", { name: "Fact detail" }).getByText(text)).toBeVisible();
});
