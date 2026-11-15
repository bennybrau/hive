// Run by scripts/test-dashboard-e2e.sh inside the Playwright image; not part of vitest or tsc.
import { expect, test, type Page } from "@playwright/test";

const HIVE = process.env.HIVE_URL ?? "http://127.0.0.1:8800";
const MEMBER = process.env.HIVE_E2E_TOKEN ?? "";
const CURATOR = process.env.HIVE_E2E_CURATOR_TOKEN ?? "";
const RUN = process.env.HIVE_E2E_RUN ?? "";

/**
 * Review shows one fact at a time: step (j on a keyboard, › on a phone) until the card is the probe, at most 100
 * times (the queue's limit), and return the card.
 */
async function stepTo(page: Page, id: string, step: () => Promise<void>) {
  const card = page.getByRole("article", { name: "Fact" });
  await expect(card).toBeVisible();
  for (let i = 0; i < 100 && (await card.getAttribute("data-id")) !== id; i++) await step();
  await expect(card).toHaveAttribute("data-id", id);
  return card;
}

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

test("a curator finds a member's candidate with j and reviews it from the keyboard, with undo", async ({ page }) => {
  expect(MEMBER, "HIVE_E2E_TOKEN is not set").not.toBe("");
  expect(CURATOR, "HIVE_E2E_CURATOR_TOKEN is not set").not.toBe("");
  expect(RUN, "HIVE_E2E_RUN is not set").not.toBe("");
  const marker = `${RUN}q${Date.now()}`;
  const text = `Dashboard e2e candidate ${marker}: reviewed from the keyboard.`;
  // A member's global fact waits for review.
  const res = await page.request.post(`${HIVE}/v1/facts`, {
    headers: { authorization: `Bearer ${MEMBER}` },
    data: { text, kind: "gotcha", scope: "global", anchors: [{ path: "README.md", line_start: 1, line_end: 3, quote: "hive" }] },
  });
  expect(res.status()).toBe(201);
  const id = (await res.json()).fact.id as string;
  created.push(id);
  expect((await res.json()).fact.status).toBe("candidate");

  await page.goto(`${HIVE}/`);
  await page.getByLabel("Token").fill(CURATOR);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("navigation", { name: "Main" })).toBeVisible();
  await expect(page).toHaveURL(/:\/\/[^/]+\/$/);
  await page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Review" }).click();
  await expect(page).toHaveURL(/\/review$/);

  // No list: one card at a time, found with j.
  await expect(page.getByRole("list", { name: "Candidates" })).toHaveCount(0);
  const card = await stepTo(page, id, () => page.keyboard.press("j"));
  const probe = page.locator(`article[data-id="${id}"]`);
  await expect(card.locator(".proposed")).toHaveText(text);
  await expect(card.getByRole("region", { name: "Why Hive thinks so" })).toContainText("README.md:L1–L3");

  // Approve, then take it back: the card returns and nothing is decided.
  await page.keyboard.press("a");
  await expect(probe).toHaveCount(0);
  await expect(page.getByRole("status")).toContainText("Approved");
  await page.getByRole("button", { name: "Undo" }).click();
  await expect(probe).toBeVisible();

  // Reject with a note; it is sent once the undo window closes.
  await page.keyboard.press("r");
  await page.getByLabel(/Why reject it/).fill(`e2e ${marker}`);
  await page.keyboard.press("Enter");
  await expect(probe).toHaveCount(0);
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

test("a curator shares a member's global candidate with a team on approve", async ({ page }) => {
  expect(MEMBER, "HIVE_E2E_TOKEN is not set").not.toBe("");
  expect(CURATOR, "HIVE_E2E_CURATOR_TOKEN is not set").not.toBe("");
  expect(RUN, "HIVE_E2E_RUN is not set").not.toBe("");
  const marker = `${RUN}s${Date.now()}`;
  const key = `e2e-${marker}`;
  const team = await page.request.post(`${HIVE}/v1/teams`, {
    headers: { authorization: `Bearer ${CURATOR}` },
    data: { key, name: `E2E ${marker}` },
  });
  expect(team.status()).toBe(201);
  const text = `Dashboard e2e candidate ${marker}: shared with a team.`;
  const res = await page.request.post(`${HIVE}/v1/facts`, {
    headers: { authorization: `Bearer ${MEMBER}` },
    data: { text, kind: "gotcha", scope: "global" },
  });
  expect(res.status()).toBe(201);
  const id = (await res.json()).fact.id as string;
  created.push(id);

  await page.goto(`${HIVE}/`);
  await page.getByLabel("Token").fill(CURATOR);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("navigation", { name: "Main" })).toBeVisible();
  await expect(page).toHaveURL(/:\/\/[^/]+\/$/);
  await page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Review" }).click();
  await expect(page).toHaveURL(/\/review$/);

  const card = await stepTo(page, id, () => page.getByRole("button", { name: "Next fact" }).click());
  await card.getByRole("button", { name: "Change…" }).click();
  await page.getByRole("group", { name: "Who should get this?" }).getByRole("radio", { name: `Team: E2E ${marker}` }).check();
  // A real click on the Approve button (the hive e2e script approves through the API instead).
  await page.getByRole("group", { name: "Decide" }).getByRole("button", { name: `Approve for Team: E2E ${marker}` }).click();
  await expect(page.locator(`article[data-id="${id}"]`)).toHaveCount(0);
  await expect(page.getByRole("status")).toContainText("Approved");
  await expect(page.getByRole("status")).toHaveCount(0, { timeout: 10_000 });

  await expect
    .poll(async () => {
      const got = await page.request.get(`${HIVE}/v1/facts/${id}`, { headers: { authorization: `Bearer ${CURATOR}` } });
      const f = (await got.json()).fact;
      return `${f.status} ${f.scope}`;
    })
    .toBe(`active team:${key}`);
});

test("a curator reviews a member's candidate on a phone, by tapping", async ({ browser }) => {
  expect(MEMBER, "HIVE_E2E_TOKEN is not set").not.toBe("");
  expect(CURATOR, "HIVE_E2E_CURATOR_TOKEN is not set").not.toBe("");
  expect(RUN, "HIVE_E2E_RUN is not set").not.toBe("");
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const page = await context.newPage();
  const marker = `${RUN}m${Date.now()}`;
  const text = `Dashboard e2e candidate ${marker}: reviewed on a phone.`;
  const res = await page.request.post(`${HIVE}/v1/facts`, {
    headers: { authorization: `Bearer ${MEMBER}` },
    data: { text, kind: "gotcha", scope: "global", anchors: [{ path: "README.md", line_start: 1, line_end: 3, quote: "hive" }] },
  });
  expect(res.status()).toBe(201);
  const id = (await res.json()).fact.id as string;
  created.push(id);

  await page.goto(`${HIVE}/`);
  await page.getByLabel("Token").fill(CURATOR);
  await page.getByRole("button", { name: "Sign in" }).tap();
  // On a phone the menu sits behind the Menu button in the top bar.
  await expect(page.getByRole("navigation", { name: "Main" })).toBeHidden();
  await page.getByRole("button", { name: "Menu" }).tap();
  await page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Review" }).tap();
  await expect(page.getByRole("navigation", { name: "Main" })).toBeHidden();
  await expect(page).toHaveURL(/\/review$/);

  // One card at a time: nothing scrolls sideways, and the decisions are pinned to the bottom of the screen under the
  // fact: Approve full width, Edit… and Reject side by side, each at least 48px tall.
  await expect(page.getByRole("list", { name: "Candidates" })).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  const card = await stepTo(page, id, () => page.getByRole("button", { name: "Next fact" }).tap());
  const decide = page.getByRole("group", { name: "Decide" });
  const bar = (await decide.boundingBox())!;
  const fact = (await card.locator(".proposed").boundingBox())!;
  expect(bar.y).toBeGreaterThan(fact.y + fact.height);
  expect(bar.y + bar.height).toBeLessThanOrEqual(844);
  const approve = (await decide.getByRole("button", { name: /^Approve for / }).boundingBox())!;
  const edit = (await decide.getByRole("button", { name: "Edit…" }).boundingBox())!;
  const reject = (await decide.getByRole("button", { name: "Reject" }).boundingBox())!;
  expect(approve.width).toBeGreaterThan(edit.width + reject.width);
  expect(edit.y).toBe(reject.y);
  for (const b of [approve, edit, reject]) expect(b.height).toBeGreaterThanOrEqual(48);

  // Edit it by tapping, then let the undo window close.
  await decide.getByRole("button", { name: "Edit…" }).tap();
  await page.getByLabel("Edit the fact").fill(`${text} Fixed.`);
  await decide.getByRole("button", { name: "Save and approve" }).tap();
  await expect(page.getByRole("status")).toContainText("Fixed");
  await expect(page.getByRole("status")).toHaveCount(0, { timeout: 10_000 });

  await expect
    .poll(async () => {
      const got = await page.request.get(`${HIVE}/v1/facts/${id}`, { headers: { authorization: `Bearer ${CURATOR}` } });
      const f = (await got.json()).fact;
      return `${f.status} ${f.text}`;
    })
    .toBe(`active ${text} Fixed.`);
  await context.close();
});

test("a curator keeps a fact the member corrected after an answer cited it", async ({ page }) => {
  expect(MEMBER, "HIVE_E2E_TOKEN is not set").not.toBe("");
  expect(CURATOR, "HIVE_E2E_CURATOR_TOKEN is not set").not.toBe("");
  expect(RUN, "HIVE_E2E_RUN is not set").not.toBe("");
  const marker = `${RUN}c${Date.now()}`;
  // The curator's global fact is active at once.
  const res = await page.request.post(`${HIVE}/v1/facts`, {
    headers: { authorization: `Bearer ${CURATOR}` },
    data: { text: `Dashboard e2e cited fact ${marker}: exports run hourly.`, kind: "convention", scope: "global" },
  });
  expect(res.status()).toBe(201);
  const id = (await res.json()).fact.id as string;
  created.push(id);
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
  await expect(page.getByRole("navigation", { name: "Main" })).toBeVisible();
  await expect(page).toHaveURL(/:\/\/[^/]+\/$/);
  await page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Review" }).click();
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
  await expect(page.getByRole("navigation", { name: "Main" })).toBeVisible();
  await expect(page).toHaveURL(/:\/\/[^/]+\/$/);
  await expect(page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Review" })).toHaveCount(0);
  await page.evaluate(() => {
    history.pushState(null, "", "/review");
    dispatchEvent(new PopStateEvent("popstate"));
  });
  await expect(page.getByRole("note")).toContainText("curators only");
});
