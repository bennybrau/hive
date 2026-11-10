// Run by scripts/test-dashboard-e2e.sh inside the Playwright image; not part of vitest or tsc.
import { expect, test } from "@playwright/test";

const HIVE = process.env.HIVE_URL ?? "http://127.0.0.1:8800";
const MEMBER = process.env.HIVE_E2E_TOKEN ?? "";
const CURATOR = process.env.HIVE_E2E_CURATOR_TOKEN ?? "";

test("a curator reviews a member's candidate from the keyboard, with undo", async ({ page }) => {
  expect(MEMBER, "HIVE_E2E_TOKEN is not set").not.toBe("");
  expect(CURATOR, "HIVE_E2E_CURATOR_TOKEN is not set").not.toBe("");
  const marker = `zq${Date.now()}`;
  const text = `Dashboard e2e candidate ${marker}: reviewed from the keyboard.`;
  // A member's global fact waits for review.
  const res = await page.request.post(`${HIVE}/v1/facts`, {
    headers: { authorization: `Bearer ${MEMBER}` },
    data: { text, kind: "gotcha", scope: "global", anchors: [{ path: "README.md", line_start: 1, line_end: 3, quote: "hive" }] },
  });
  expect(res.status()).toBe(201);
  const id = (await res.json()).fact.id as string;
  expect((await res.json()).fact.status).toBe("candidate");

  await page.goto(`${HIVE}/`);
  await page.getByLabel("Token").fill(CURATOR);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/facts$/);
  await page.getByRole("link", { name: "Review" }).click();
  await expect(page).toHaveURL(/\/review$/);

  const row = page.getByRole("list", { name: "Candidates" }).locator(`li[data-id="${id}"]`);
  await row.click();
  await expect(row).toHaveAttribute("aria-current", "true");
  const panel = page.getByRole("complementary", { name: "Evidence" });
  await expect(panel.getByText(text)).toBeVisible();
  await expect(panel.getByText("README.md:L1–L3")).toBeVisible();

  // Approve, then take it back: the row returns and nothing is decided.
  await page.keyboard.press("a");
  await expect(row).toHaveCount(0);
  await expect(page.getByRole("status")).toContainText("Approved");
  await page.getByRole("button", { name: "Undo" }).click();
  await expect(row).toHaveAttribute("aria-current", "true");

  // Reject with a note; it is sent once the undo window closes.
  await page.keyboard.press("r");
  await page.getByLabel(/Why reject it/).fill(`e2e ${marker}`);
  await page.keyboard.press("Enter");
  await expect(row).toHaveCount(0);
  await expect(page.getByRole("status")).toContainText("Rejected");
  await expect(page.getByRole("status")).toHaveCount(0, { timeout: 10_000 });

  await expect
    .poll(async () => {
      const got = await page.request.get(`${HIVE}/v1/facts/${id}`, { headers: { authorization: `Bearer ${CURATOR}` } });
      const f = (await got.json()).fact;
      return `${f.status} ${f.status_note}`;
    })
    .toBe(`retracted rejected: e2e ${marker}`);
});

test("a curator reviews a member's candidate on a phone, by tapping", async ({ browser }) => {
  expect(MEMBER, "HIVE_E2E_TOKEN is not set").not.toBe("");
  expect(CURATOR, "HIVE_E2E_CURATOR_TOKEN is not set").not.toBe("");
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const page = await context.newPage();
  const marker = `zm${Date.now()}`;
  const text = `Dashboard e2e candidate ${marker}: reviewed on a phone.`;
  const res = await page.request.post(`${HIVE}/v1/facts`, {
    headers: { authorization: `Bearer ${MEMBER}` },
    data: { text, kind: "gotcha", scope: "global", anchors: [{ path: "README.md", line_start: 1, line_end: 3, quote: "hive" }] },
  });
  expect(res.status()).toBe(201);
  const id = (await res.json()).fact.id as string;

  await page.goto(`${HIVE}/`);
  await page.getByLabel("Token").fill(CURATOR);
  await page.getByRole("button", { name: "Sign in" }).tap();
  await page.getByRole("link", { name: "Review" }).tap();
  await expect(page).toHaveURL(/\/review$/);

  // One card at a time: the list is hidden, nothing scrolls sideways, and the decisions are on screen under the fact.
  await expect(page.getByRole("list", { name: "Candidates" })).toBeHidden();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  const card = page.getByRole("complementary", { name: "Evidence" });
  const next = page.getByRole("button", { name: "Next candidate" });
  for (let i = 0; i < 100 && !(await card.getByText(text).isVisible()); i++) await next.tap();
  await expect(card.getByText(text)).toBeVisible();
  const decide = page.getByRole("group", { name: "Decide" });
  const bar = (await decide.boundingBox())!;
  const fact = (await card.getByText(text).boundingBox())!;
  expect(bar.y).toBeGreaterThan(fact.y + fact.height);
  expect(bar.y + bar.height).toBeLessThanOrEqual(844);
  expect(bar.height).toBeGreaterThanOrEqual(48);

  // Fix it by tapping, then let the undo window close.
  await decide.getByRole("button", { name: "Fix…" }).tap();
  await page.getByLabel("Fixed text").fill(`${text} Fixed.`);
  await decide.getByRole("button", { name: "Save fix" }).tap();
  await expect(page.getByRole("status")).toContainText("Fixed");
  await expect(page.getByRole("status")).toHaveCount(0, { timeout: 10_000 });

  await expect
    .poll(async () => {
      const got = await page.request.get(`${HIVE}/v1/facts/${id}`, { headers: { authorization: `Bearer ${CURATOR}` } });
      const f = (await got.json()).fact;
      return `${f.status} ${f.text}`;
    })
    .toBe(`active ${text} Fixed.`);
  // It is active and global now, so retire it before an assistant recalls it.
  const retire = await page.request.post(`${HIVE}/v1/facts/${id}/curate`, {
    headers: { authorization: `Bearer ${CURATOR}` },
    data: { action: "retire", note: "e2e" },
  });
  expect(retire.status()).toBe(200);
  await context.close();
});

test("a curator keeps a fact the member corrected after an answer cited it", async ({ page }) => {
  expect(MEMBER, "HIVE_E2E_TOKEN is not set").not.toBe("");
  expect(CURATOR, "HIVE_E2E_CURATOR_TOKEN is not set").not.toBe("");
  const marker = `zc${Date.now()}`;
  // The curator's global fact is active at once.
  const res = await page.request.post(`${HIVE}/v1/facts`, {
    headers: { authorization: `Bearer ${CURATOR}` },
    data: { text: `Dashboard e2e cited fact ${marker}: exports run hourly.`, kind: "convention", scope: "global" },
  });
  expect(res.status()).toBe(201);
  const id = (await res.json()).fact.id as string;
  expect((await res.json()).fact.status).toBe("active");

  // The member's answer cites it, and the next turn of the session corrects that answer.
  const turn = (content: string, metadata: Record<string, unknown>) =>
    page.request.post(`${HIVE}/v1/episodes`, {
      headers: { authorization: `Bearer ${MEMBER}` },
      data: { kind: "turn", session_id: `e2e-${marker}`, content, metadata },
    });
  expect((await turn("user: how often do exports run?\nassistant: Hourly.", { cited: [id.slice(0, 8)] })).status()).toBe(201);
  const said = `no, exports run daily now ${marker}`;
  expect((await turn(`user: ${said}\nassistant: Sorry.`, { correction: true })).status()).toBe(201);

  await page.goto(`${HIVE}/`);
  await page.getByLabel("Token").fill(CURATOR);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/facts$/);
  await page.getByRole("link", { name: "Review" }).click();
  await expect(page).toHaveURL(/\/review$/);

  const card = page.getByRole("region", { name: "Corrected after citation" }).locator(`li[data-id="${id}"]`);
  await expect(card).toContainText(marker);
  await expect(card.locator("blockquote")).toHaveText(said);
  await card.getByRole("button", { name: "Keep" }).click();
  await expect(card).toHaveCount(0);
  await expect(page.getByRole("status")).toContainText("Kept");
  await expect(page.getByRole("status")).toHaveCount(0, { timeout: 10_000 });

  await expect
    .poll(async () => {
      const got = await page.request.get(`${HIVE}/v1/facts/${id}`, { headers: { authorization: `Bearer ${CURATOR}` } });
      const f = (await got.json()).fact;
      return `${f.status} ${"correction" in (f.metadata ?? {})}`;
    })
    .toBe("active false");
});

test("a member sees no Review link and a curators-only note at /review", async ({ page }) => {
  expect(MEMBER, "HIVE_E2E_TOKEN is not set").not.toBe("");
  await page.goto(`${HIVE}/`);
  await page.getByLabel("Token").fill(MEMBER);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/facts$/);
  await expect(page.getByRole("link", { name: "Review" })).toHaveCount(0);
  await page.evaluate(() => {
    history.pushState(null, "", "/review");
    dispatchEvent(new PopStateEvent("popstate"));
  });
  await expect(page.getByRole("note")).toContainText("curators only");
});
