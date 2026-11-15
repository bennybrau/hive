// Run by scripts/test-dashboard-e2e.sh inside the Playwright image; not part of vitest or tsc.
import { expect, test, type Page } from "@playwright/test";

const HIVE = process.env.HIVE_URL ?? "http://127.0.0.1:8800";
const MEMBER = process.env.HIVE_E2E_TOKEN ?? "";
const CURATOR = process.env.HIVE_E2E_CURATOR_TOKEN ?? "";

async function signIn(page: Page, token: string) {
  await page.goto(`${HIVE}/`);
  await page.getByLabel("Token").fill(token);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("navigation", { name: "Main" })).toBeVisible();
  await expect(page).toHaveURL(/:\/\/[^/]+\/$/);
}

test("a curator's Home has Needs you, with the review, out of date and sources lines", async ({ page }) => {
  expect(CURATOR, "HIVE_E2E_CURATOR_TOKEN is not set").not.toBe("");
  await signIn(page, CURATOR);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(/^Good (morning|afternoon|evening), /);
  const main = page.getByRole("navigation", { name: "Main" });
  await expect(main.getByRole("link", { name: "Home" })).toHaveAttribute("aria-current", "page");

  const needs = page.getByRole("region", { name: "Needs you" });
  await expect(needs).toBeVisible();
  await expect(needs.locator(".todo")).toHaveCount(3);
  await expect(needs.getByRole("link", { name: "See the list" })).toHaveAttribute("href", "/stale");
  await expect(needs.getByRole("link", { name: "Check sources" })).toHaveAttribute("href", "/repos");
  // At most one primary button, and only when something is waiting.
  expect(await page.locator(".btn.primary").count()).toBeLessThanOrEqual(1);
  await expect(page.getByRole("heading", { name: "This month" })).toBeVisible();
  await expect(page.getByRole("region", { name: "What Hive knows" })).toBeVisible();
});

test("a member's Home has no Needs you and no cost", async ({ page }) => {
  expect(MEMBER, "HIVE_E2E_TOKEN is not set").not.toBe("");
  await signIn(page, MEMBER);
  await expect(page.getByRole("region", { name: "What Hive knows" })).toBeVisible();
  await expect(page.getByRole("region", { name: "Needs you" })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "This month" })).toHaveCount(0);
  await expect(page.locator(".btn.primary")).toHaveCount(0);
});
