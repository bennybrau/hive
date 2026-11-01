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
