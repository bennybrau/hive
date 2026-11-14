// Run by scripts/test-dashboard-e2e.sh inside the Playwright image; not part of vitest or tsc.
import { expect, test } from "@playwright/test";

const HIVE = process.env.HIVE_URL ?? "http://127.0.0.1:8800";
const TOKEN = process.env.HIVE_E2E_TOKEN ?? "";
const CURATOR = process.env.HIVE_E2E_CURATOR_TOKEN ?? "";
const RUN = process.env.HIVE_E2E_RUN ?? "";

// Ids this spec made; afterAll retires the ones still active (scripts/test-dashboard-e2e.sh's trap is the backstop).
const created: string[] = [];
test.afterAll(async ({ request }) => {
  const auth = { authorization: `Bearer ${CURATOR}` };
  for (const id of created) {
    try {
      const got = await request.get(`${HIVE}/v1/facts/${id}`, { headers: auth });
      if (!got.ok() || (await got.json()).fact.status !== "active") continue;
      await request.post(`${HIVE}/v1/facts/${id}/curate`, { headers: auth, data: { action: "retire", note: "e2e cleanup" } });
    } catch {
      // Ignored: the script's trap retracts whatever is left.
    }
  }
});

test("filter, search and open a fresh personal fact", async ({ page }) => {
  expect(TOKEN, "HIVE_E2E_TOKEN is not set").not.toBe("");
  expect(RUN, "HIVE_E2E_RUN is not set").not.toBe("");
  const marker = `${RUN}q${Date.now()}`;
  const text = `Dashboard e2e fact ${marker}: a new anchor stays unverified until checked.`;
  const res = await page.request.post(`${HIVE}/v1/facts`, {
    headers: { authorization: `Bearer ${TOKEN}` },
    data: { text, kind: "gotcha", scope: "personal", anchors: [{ path: "README.md", line_start: 1, quote: "hive" }] },
  });
  expect(res.status()).toBe(201);
  created.push((await res.json()).fact.id);

  await page.goto(`${HIVE}/`);
  await page.getByLabel("Token").fill(TOKEN);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/facts$/);

  await page.getByLabel("Who gets it").selectOption("personal");
  await page.getByLabel("Came from").selectOption("authored");
  await expect(page).toHaveURL(/level=personal/);
  await page.getByLabel("Search facts").fill(marker);
  await page.getByLabel("Search facts").press("Enter");
  await expect(page.getByRole("note")).toContainText("At most 100");

  await page.getByRole("link", { name: text }).click();
  await expect(page).toHaveURL(/\/facts\/[0-9a-f-]+\?.*q=/);
  const panel = page.getByRole("complementary", { name: "Selected fact" });
  await expect(panel.getByText(text)).toBeVisible();
  // Hive's verify job may reach the new anchor within a second (a path with no repo is "unverifiable here"), so
  // either plain state is right; what must never show is the raw value.
  await expect(panel.getByRole("list", { name: "Where this comes from" }).getByText(/^(Not checked yet|Can't check from here)$/)).toBeVisible();
});

test("on a phone a fact opens as its own page, and the back link returns to the list", async ({ browser }) => {
  expect(TOKEN, "HIVE_E2E_TOKEN is not set").not.toBe("");
  expect(RUN, "HIVE_E2E_RUN is not set").not.toBe("");
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const page = await context.newPage();
  const marker = `${RUN}p${Date.now()}`;
  const text = `Dashboard e2e phone fact ${marker}: opened as its own page.`;
  const res = await page.request.post(`${HIVE}/v1/facts`, {
    headers: { authorization: `Bearer ${TOKEN}` },
    data: { text, kind: "gotcha", scope: "personal" },
  });
  expect(res.status()).toBe(201);
  created.push((await res.json()).fact.id);

  await page.goto(`${HIVE}/`);
  await page.getByLabel("Token").fill(TOKEN);
  await page.getByRole("button", { name: "Sign in" }).tap();
  await expect(page).toHaveURL(/\/facts$/);
  await page.getByLabel("Search facts").fill(marker);
  await page.getByLabel("Search facts").press("Enter");
  await page.getByRole("link", { name: text }).tap();

  // The list, its header and filters give way to the fact; nothing scrolls sideways; Close is the back link here.
  await expect(page).toHaveURL(/\/facts\/[0-9a-f-]+\?q=/);
  const panel = page.getByRole("complementary", { name: "Selected fact" });
  await expect(panel.getByText(text)).toBeVisible();
  await expect(page.getByLabel("Search facts")).toBeHidden();
  await expect(panel.getByRole("button", { name: "Close" })).toBeHidden();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);

  // The section tabs have a Facts link too; the back link is the one in the page.
  const back = page.getByRole("main").getByRole("link", { name: "Facts", exact: true });
  await expect(back).toBeVisible();
  await back.tap();
  await expect(page).toHaveURL(new RegExp(`/facts\\?q=${marker}$`));
  await expect(page.getByLabel("Search facts")).toBeVisible();
  await expect(page.getByRole("link", { name: text })).toBeFocused();
  await context.close();
});
