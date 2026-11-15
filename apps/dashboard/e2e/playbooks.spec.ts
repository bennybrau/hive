// Run by scripts/test-dashboard-e2e.sh inside the Playwright image; not part of vitest or tsc.
import { expect, test } from "@playwright/test";

const HIVE = process.env.HIVE_URL ?? "http://127.0.0.1:8800";
const CURATOR = process.env.HIVE_E2E_CURATOR_TOKEN ?? "";

test("a curator creates a playbook and the brief picks it up", async ({ page }) => {
  expect(CURATOR, "HIVE_E2E_CURATOR_TOKEN is not set").not.toBe("");
  const marker = `zq${Date.now()}`;
  // A throwaway repo scope keeps it out of real briefs.
  const repo = `e2e-${marker}`;
  const title = `E2E playbook ${marker}`;
  const auth = { authorization: `Bearer ${CURATOR}` };

  await page.goto(`${HIVE}/`);
  await page.getByLabel("Token").fill(CURATOR);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("navigation", { name: "Main" })).toBeVisible();
  await expect(page).toHaveURL(/:\/\/[^/]+\/$/);
  await page.getByRole("link", { name: "Playbooks" }).click();
  await expect(page).toHaveURL(/\/playbooks$/);
  await page.getByRole("button", { name: "New playbook" }).click();

  await page.getByLabel("Title").fill(title);
  await page.getByLabel("Scope").selectOption("repo");
  await page.getByLabel("Repo").fill(repo);
  await page.getByLabel("Task words").fill(marker);
  await page.getByRole("button", { name: "Add step" }).click();
  await page.getByLabel("Step 1", { exact: true }).fill("Do the first thing");
  await page.getByRole("button", { name: "Create playbook" }).click();
  await expect(page.getByRole("heading", { name: title })).toBeVisible();
  const id = decodeURIComponent(new URL(page.url()).pathname.split("/").pop()!);

  try {
    const res = await page.request.post(`${HIVE}/v1/brief`, {
      headers: auth,
      data: { task: `please handle the ${marker} change`, repo_key: repo },
    });
    expect(res.status()).toBe(200);
    expect((await res.json()).playbook[0]?.title).toBe(title);
  } finally {
    const del = await page.request.delete(`${HIVE}/v1/playbooks/${id}`, { headers: auth });
    expect(del.status()).toBe(200);
  }
});
