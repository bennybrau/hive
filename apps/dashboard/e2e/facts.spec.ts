// Run by scripts/test-dashboard-e2e.sh inside the Playwright image; not part of vitest or tsc.
import { expect, test } from "@playwright/test";

const HIVE = process.env.HIVE_URL ?? "http://127.0.0.1:8800";
const TOKEN = process.env.HIVE_E2E_TOKEN ?? "";

test("filter, search and open a fresh personal fact", async ({ page }) => {
  expect(TOKEN, "HIVE_E2E_TOKEN is not set").not.toBe("");
  const marker = `zq${Date.now()}`;
  const text = `Dashboard e2e fact ${marker}: a new anchor stays unverified until checked.`;
  const res = await page.request.post(`${HIVE}/v1/facts`, {
    headers: { authorization: `Bearer ${TOKEN}` },
    data: { text, kind: "gotcha", scope: "personal", anchors: [{ path: "README.md", line_start: 1, quote: "hive" }] },
  });
  expect(res.status()).toBe(201);

  await page.goto(`${HIVE}/`);
  await page.getByLabel("Token").fill(TOKEN);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/facts$/);

  await page.getByLabel("Scope").selectOption("personal");
  await page.getByLabel("Origin").selectOption("authored");
  await expect(page).toHaveURL(/scope=personal/);
  await page.getByLabel("Search").fill(marker);
  await page.getByRole("button", { name: "Search" }).click();
  await expect(page.getByRole("note")).toContainText("no paging");

  await page.getByRole("cell", { name: text }).click();
  await expect(page).toHaveURL(/\/facts\/[0-9a-f-]+\?.*q=/);
  const panel = page.getByRole("complementary", { name: "Fact detail" });
  await expect(panel.getByText(text)).toBeVisible();
  await expect(panel.locator(".badge")).toHaveText("unverified");
});
