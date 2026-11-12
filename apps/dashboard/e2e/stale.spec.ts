// Run by scripts/test-dashboard-e2e.sh inside the Playwright image; not part of vitest or tsc.
import { expect, test } from "@playwright/test";

const HIVE = process.env.HIVE_URL ?? "http://127.0.0.1:8800";
const MEMBER = process.env.HIVE_E2E_TOKEN ?? "";
const CURATOR = process.env.HIVE_E2E_CURATOR_TOKEN ?? "";
// Four active global facts the script backdated 400 days.
const STALE = (process.env.HIVE_E2E_STALE_IDS ?? "").split(",").filter(Boolean);

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

test("a curator keeps, fixes, retires and pins stale facts", async ({ page }) => {
  expect(CURATOR, "HIVE_E2E_CURATOR_TOKEN is not set").not.toBe("");
  expect(STALE, "HIVE_E2E_STALE_IDS is not set").toHaveLength(4);
  expect(RUN, "HIVE_E2E_RUN is not set").not.toBe("");
  created.push(...STALE);
  const [keep, fix, retire, pin] = STALE as [string, string, string, string];
  const marker = `${RUN}f${Date.now()}`;
  const get = async (id: string) => {
    const res = await page.request.get(`${HIVE}/v1/facts/${id}`, { headers: { authorization: `Bearer ${CURATOR}` } });
    return res.json();
  };

  await page.goto(`${HIVE}/`);
  await page.getByLabel("Token").fill(CURATOR);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/facts$/);
  await page.getByRole("link", { name: "Stale" }).click();
  await expect(page).toHaveURL(/\/stale$/);

  const list = page.getByRole("list", { name: "Stale facts" });
  const panel = page.getByRole("complementary", { name: "Fact" });
  const row = (id: string) => list.locator(`li[data-id="${id}"]`);
  for (const id of STALE) await expect(row(id)).toContainText("idle 400 days");

  await row(keep).click();
  await expect(panel.getByText("never")).toBeVisible();
  await panel.getByRole("button", { name: "Keep" }).click();
  await expect(row(keep)).toHaveCount(0);

  await row(fix).click();
  await panel.getByRole("button", { name: "Fix" }).click();
  const fixed = `Dashboard e2e stale fact fixed ${marker}`;
  await panel.getByLabel("Fixed text").fill(fixed);
  await page.keyboard.press("Enter");
  await expect(row(fix)).toHaveCount(0);

  await row(retire).click();
  await panel.getByRole("button", { name: "Retire" }).click();
  await panel.getByLabel("Why retire it? (optional)").fill(`e2e ${marker}`);
  await panel.getByRole("button", { name: "Retire fact" }).click();
  await expect(row(retire)).toHaveCount(0);

  await row(pin).click();
  await panel.getByRole("button", { name: "Pin" }).click();
  await expect(row(pin)).toHaveCount(0);

  const k = (await get(keep)).fact;
  expect([k.status, k.stale]).toEqual(["active", false]);
  const f = await get(fix);
  expect(f.fact.status).toBe("superseded");
  created.push(f.superseded_by[0].id);
  expect(f.superseded_by[0].text).toBe(fixed);
  const r = (await get(retire)).fact;
  expect(`${r.status} ${r.status_note}`).toBe(`retracted retired: e2e ${marker}`);
  const p = (await get(pin)).fact;
  expect([p.status, p.pinned, p.stale]).toEqual(["active", true, false]);
});

test("a member sees no Stale link and a curators-only note at /stale", async ({ page }) => {
  expect(MEMBER, "HIVE_E2E_TOKEN is not set").not.toBe("");
  await page.goto(`${HIVE}/`);
  await page.getByLabel("Token").fill(MEMBER);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/facts$/);
  await expect(page.getByRole("link", { name: "Stale" })).toHaveCount(0);
  await page.evaluate(() => {
    history.pushState(null, "", "/stale");
    dispatchEvent(new PopStateEvent("popstate"));
  });
  await expect(page.getByRole("note")).toContainText("curators only");
});
