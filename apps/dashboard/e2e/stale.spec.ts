// Run by scripts/test-dashboard-e2e.sh inside the Playwright image; not part of vitest or tsc.
import { expect, test } from "@playwright/test";

const HIVE = process.env.HIVE_URL ?? "http://127.0.0.1:8800";
const MEMBER = process.env.HIVE_E2E_TOKEN ?? "";
const CURATOR = process.env.HIVE_E2E_CURATOR_TOKEN ?? "";
// Four active facts the script backdated 400 days, in a repo nothing else reads.
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
  await page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Review" }).click();
  await page.getByRole("navigation", { name: "Review pages" }).getByRole("link", { name: "Out of date" }).click();
  await expect(page).toHaveURL(/\/stale$/);

  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Out of date");
  const card = page.getByRole("article", { name: "Fact" });
  const decide = card.getByRole("group", { name: "Decide" });
  // One card at a time: step › until the card is this fact. If it was used or touched since the script made it, it
  // isn't out of date any more; say why.
  const prev = card.getByRole("button", { name: "Previous fact" });
  const next = card.getByRole("button", { name: "Next fact" });
  const show = async (id: string) => {
    await expect(card).toBeVisible();
    while (await prev.isEnabled()) await prev.click();
    const of = Number((await card.locator(".pos .label").textContent())!.replace(/.* of /, ""));
    for (let i = 0; i < of && (await card.getAttribute("data-id")) !== id && (await next.isEnabled()); i++) await next.click();
    if ((await card.getAttribute("data-id")) !== id) {
      const { status, stale, use_count, cite_count, last_used_at, pinned } = (await get(id)).fact;
      const state = JSON.stringify({ status, stale, use_count, cite_count, last_used_at, pinned });
      throw new Error(`stale fact ${id} isn't shown: ${state}`);
    }
  };
  const gone = async (id: string) => expect(page.locator(`article[data-id="${id}"]`)).toHaveCount(0);

  await show(keep);
  await expect(card.getByText(/^Never used since it was added/)).toBeVisible();
  await decide.getByRole("button", { name: "Keep" }).click();
  await gone(keep);

  await show(fix);
  await decide.getByRole("button", { name: "Edit…" }).click();
  const fixed = `Dashboard e2e stale fact fixed ${marker}`;
  await card.getByLabel("Edit the fact").fill(fixed);
  await page.keyboard.press("Enter");
  await gone(fix);

  await show(retire);
  await decide.getByRole("button", { name: "Retire" }).click();
  await card.getByLabel("Why retire it? (optional)").fill(`e2e ${marker}`);
  await decide.getByRole("button", { name: "Retire fact" }).click();
  await gone(retire);

  await show(pin);
  await decide.getByRole("button", { name: "Pin" }).click();
  await gone(pin);

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

test("a member sees no Out of date link and a curators-only note at /stale", async ({ page }) => {
  expect(MEMBER, "HIVE_E2E_TOKEN is not set").not.toBe("");
  await page.goto(`${HIVE}/`);
  await page.getByLabel("Token").fill(MEMBER);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/facts$/);
  await expect(page.getByRole("link", { name: "Review" })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Out of date" })).toHaveCount(0);
  await page.evaluate(() => {
    history.pushState(null, "", "/stale");
    dispatchEvent(new PopStateEvent("popstate"));
  });
  await expect(page.getByRole("note")).toContainText("curators only");
});
