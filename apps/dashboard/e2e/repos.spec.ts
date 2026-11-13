// Run by scripts/test-dashboard-e2e.sh inside the Playwright image; not part of vitest or tsc.
import { expect, test } from "@playwright/test";

const HIVE = process.env.HIVE_URL ?? "http://127.0.0.1:8800";
const MEMBER = process.env.HIVE_E2E_TOKEN ?? "";
const CURATOR = process.env.HIVE_E2E_CURATOR_TOKEN ?? "";

async function signIn(page: import("@playwright/test").Page, token: string) {
  await page.goto(`${HIVE}/`);
  await page.getByLabel("Token").fill(token);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/facts$/);
  await page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Admin" }).click();
  await expect(page).toHaveURL(/\/repos$/);
}

test("a member sees repos with anchor health, but no Read again now", async ({ page }) => {
  expect(MEMBER, "HIVE_E2E_TOKEN is not set").not.toBe("");
  const res = await page.request.get(`${HIVE}/v1/repos`, { headers: { authorization: `Bearer ${MEMBER}` } });
  const repos = (await res.json()).repos as { key: string; anchors: { verified: number } }[];
  test.skip(repos.length === 0, "no repos registered on this hive");

  await signIn(page, MEMBER);
  const row = page.locator(`li[data-key="${repos[0]!.key}"]`);
  await expect(row.getByRole("heading", { name: repos[0]!.key })).toBeVisible();
  await expect(row.getByLabel("Anchor health")).toContainText(`${repos[0]!.anchors.verified} Still matches`);
  await expect(page.getByRole("button", { name: "Read again now" })).toHaveCount(0);

  const files = row.getByRole("button", { name: "Files not indexed" });
  await files.click();
  await expect(files).toHaveAttribute("aria-expanded", "true");
  await expect(row.getByText("All files indexed.").or(row.getByRole("table"))).toBeVisible();
});

test("a curator reads a repo again now and sees both summaries", async ({ page }) => {
  expect(CURATOR, "HIVE_E2E_CURATOR_TOKEN is not set").not.toBe("");
  const res = await page.request.get(`${HIVE}/v1/repos`, { headers: { authorization: `Bearer ${CURATOR}` } });
  const repos = (await res.json()).repos as { key: string }[];
  test.skip(repos.length === 0, "no repos registered on this hive");

  await signIn(page, CURATOR);
  const row = page.locator(`li[data-key="${repos[0]!.key}"]`);
  await row.getByRole("button", { name: "Read again now" }).click();
  await expect(row.getByRole("status")).toContainText("Checked", { timeout: 120_000 });
  await expect(row.getByRole("button", { name: "Read again now" })).toBeEnabled();
});
