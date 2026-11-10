// Run by scripts/test-dashboard-e2e.sh inside the Playwright image; not part of vitest or tsc.
import { createServer, type AddressInfo, type Server } from "node:net";
import { expect, test, type Page } from "@playwright/test";

const HIVE = process.env.HIVE_URL ?? "http://127.0.0.1:8800";
const MEMBER = process.env.HIVE_E2E_TOKEN ?? "";
const CURATOR = process.env.HIVE_E2E_CURATOR_TOKEN ?? "";
/** The `from` this spec saves; a digest saved with any other one is someone's real config. */
const FROM = "hive-e2e@example.test";

async function signIn(page: Page, token: string) {
  await page.goto(`${HIVE}/`);
  await page.getByLabel("Token", { exact: true }).fill(token);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/facts$/);
}

/**
 * A just-enough SMTP server on 127.0.0.1 (the hive shares this network namespace). It takes any login,
 * since nodemailer always authenticates when given a user, and keeps every message's raw DATA.
 */
function fakeSmtp(): Promise<{ server: Server; port: number; messages: string[] }> {
  const messages: string[] = [];
  const server = createServer((sock) => {
    let buf = "";
    let data: string[] | null = null;
    let auth: "plain" | "user" | "pass" | null = null;
    const say = (s: string) => sock.write(`${s}\r\n`);
    say("220 hive-e2e ESMTP");
    sock.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      let i: number;
      while ((i = buf.indexOf("\r\n")) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 2);
        if (data) {
          if (line === ".") {
            messages.push(data.join("\n"));
            data = null;
            say("250 queued");
          } else data.push(line);
          continue;
        }
        if (auth) {
          auth = auth === "user" ? "pass" : null;
          say(auth ? "334 UGFzc3dvcmQ6" : "235 ok");
          continue;
        }
        const [verb = "", arg] = line.split(" ");
        switch (verb.toUpperCase()) {
          case "EHLO":
            say("250-hive-e2e");
            say("250-AUTH PLAIN LOGIN");
            say("250 8BITMIME");
            break;
          case "AUTH":
            if (arg?.toUpperCase() === "LOGIN") {
              auth = "user";
              say("334 VXNlcm5hbWU6");
            } else if (line.split(" ").length > 2) say("235 ok");
            else {
              auth = "plain";
              say("334 ");
            }
            break;
          case "DATA":
            data = [];
            say("354 go ahead");
            break;
          case "QUIT":
            say("221 bye");
            sock.end();
            break;
          default:
            say("250 ok");
        }
      }
    });
    sock.on("error", () => {});
  });
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve({ server, port: (server.address() as AddressInfo).port, messages })),
  );
}

test("a curator saves the digest settings and sends a test: email arrives, a bad bot token fails", async ({ page }) => {
  test.setTimeout(120_000); // each failing channel is tried 3 times, 10 s timeout each
  expect(CURATOR, "HIVE_E2E_CURATOR_TOKEN is not set").not.toBe("");
  const res = await page.request.get(`${HIVE}/v1/settings`, { headers: { authorization: `Bearer ${CURATOR}` } });
  const current = (await res.json()).review_digest as { channels: { email: { from: string } | null } } | null;
  test.skip(
    !!current && current.channels.email?.from !== FROM && !process.env.HIVE_E2E_DIGEST_OVERWRITE,
    "this hive has a real review digest configured; HIVE_E2E_DIGEST_OVERWRITE=1 replaces it",
  );

  const smtp = await fakeSmtp();
  try {
    const stamp = Date.now();
    const smtpPass = `e2e-smtp-pass-${stamp}`;
    const botToken = `0:e2e-bogus-token-${stamp}`;

    await signIn(page, CURATOR);
    await page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Settings" }).click();
    await expect(page).toHaveURL(/\/settings$/);
    await expect(page.getByLabel("Dashboard link", { exact: true })).toHaveValue(new URL(HIVE).origin);

    await page.getByRole("switch", { name: "Send the daily digest" }).uncheck();
    await page.getByRole("switch", { name: "Send by email" }).check();
    await page.getByLabel("SMTP host", { exact: true }).fill("127.0.0.1");
    await page.getByLabel("SMTP port", { exact: true }).fill(String(smtp.port));
    await page.getByLabel(/^Secure connection/).uncheck();
    await page.getByLabel("SMTP user", { exact: true }).fill("e2e");
    await page.getByLabel("SMTP password", { exact: true }).fill(smtpPass);
    await page.getByLabel("From", { exact: true }).fill(FROM);
    await page.getByLabel("To", { exact: true }).fill("curator-e2e@example.test");
    await page.getByRole("switch", { name: "Send by Telegram" }).check();
    await page.getByLabel("Bot token", { exact: true }).fill(botToken);
    await page.getByLabel("Chat id", { exact: true }).fill("1");
    await page.getByRole("button", { name: "Save" }).click();
    await expect(page.getByRole("status")).toHaveText("Saved.");

    await page.reload();
    await expect(page.getByLabel("SMTP host", { exact: true })).toHaveValue("127.0.0.1");
    await expect(page.getByLabel("SMTP password", { exact: true })).toHaveAttribute("placeholder", "saved");
    await expect(page.getByLabel("Bot token", { exact: true })).toHaveAttribute("placeholder", "saved");

    await page.getByRole("button", { name: "Send test" }).click();
    const results = page.getByRole("list", { name: "Test results" });
    await expect(results).toBeVisible({ timeout: 90_000 });
    await expect(results.locator('li[data-channel="email"]')).toHaveAttribute("data-status", "sent");
    await expect(results.locator('li[data-channel="email"]')).toContainText("✓ Sent");
    await expect(results.locator('li[data-channel="telegram"]')).toHaveAttribute("data-status", "failed");
    await expect(results.locator('li[data-channel="telegram"] .error')).not.toBeEmpty();
    expect(smtp.messages.some((m) => m.includes(FROM))).toBe(true);

    const html = await page.content();
    expect(html).not.toContain(smtpPass);
    expect(html).not.toContain(botToken);
    expect(html).not.toContain(botToken.split(":")[1]);
  } finally {
    await new Promise((r) => smtp.server.close(r));
  }
});

test("a member sees no Settings link and a curators-only note at /settings", async ({ page }) => {
  expect(MEMBER, "HIVE_E2E_TOKEN is not set").not.toBe("");
  await signIn(page, MEMBER);
  await expect(page.getByRole("link", { name: "Settings" })).toHaveCount(0);
  await page.evaluate(() => {
    history.pushState(null, "", "/settings");
    dispatchEvent(new PopStateEvent("popstate"));
  });
  await expect(page.getByRole("note")).toHaveText("Only a curator can change settings.");
});
