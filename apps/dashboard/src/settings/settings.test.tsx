import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../App";
import { Settings, type DigestView, type TestResult } from "./Settings";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

let digest: DigestView | null;
let role: string;
let putAnswer: () => Response;
let testAnswer: TestResult;
const puts: unknown[] = [];

const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(String(input), "http://hive");
  if (url.pathname === "/v1/settings") return json({ agent_credential: { present: false, set_at: null }, review_digest: digest });
  if (url.pathname === "/v1/settings/review-digest") {
    puts.push(JSON.parse(String(init?.body)));
    return putAnswer();
  }
  if (url.pathname === "/v1/review-digest/test") return json(testAnswer);
  if (url.pathname === "/v1/status") {
    return json({ version: "test", instance: { id: "i1", name: "jon-mac", user_id: "jon", role } });
  }
  return json({ candidates: [], last_distill_at: null, facts: [], total: 0 });
});

const input = (label: string) => screen.getByLabelText(label) as HTMLInputElement;
const type = (label: string, value: string) => fireEvent.change(input(label), { target: { value } });
const save = () => fireEvent.click(screen.getByRole("button", { name: "Save" }));

beforeEach(() => {
  sessionStorage.clear();
  history.replaceState(null, "", "/");
  role = "curator";
  puts.length = 0;
  putAnswer = () => new Response(null, { status: 204 });
  digest = {
    enabled: true,
    time: "07:30",
    timezone: "Europe/Berlin",
    dashboard_url: "https://hive.example.com",
    channels: {
      email: { smtp_host: "smtp.example.com", smtp_port: 587, smtp_secure: false, smtp_user: "hive", from: "hive@example.com", to: ["jon@example.com", "ann@example.com"] },
      telegram: { chat_id: "-100123" },
    },
    last_sent_at: new Date(Date.now() - 2 * 3600_000).toISOString(),
    last_item_count: 4,
    last_error: "telegram: Forbidden",
  };
  testAnswer = { email: { status: "sent", error: null }, telegram: { status: "failed", error: "Unauthorized" } };
  fetchMock.mockClear();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("settings page", () => {
  it("loads and shows the saved state, with secrets only as 'saved'", async () => {
    render(<Settings role="curator" />);
    await screen.findByRole("form", { name: "Daily review digest" });
    expect((screen.getByRole("switch", { name: "Send the daily digest" }) as HTMLInputElement).checked).toBe(true);
    expect(input("Time").value).toBe("07:30");
    expect((screen.getByLabelText("Time zone") as HTMLSelectElement).value).toBe("Europe/Berlin");
    expect(input("Dashboard link").value).toBe("https://hive.example.com");
    expect(input("SMTP host").value).toBe("smtp.example.com");
    expect(input("SMTP port").value).toBe("587");
    expect(input("SMTP user").value).toBe("hive");
    expect(input("To").value).toBe("jon@example.com, ann@example.com");
    expect(input("SMTP password").value).toBe("");
    expect(input("SMTP password").placeholder).toBe("saved");
    expect(input("Bot token").placeholder).toBe("saved");
    expect(input("Chat id").value).toBe("-100123");
    const last = screen.getByLabelText("Last digest");
    expect(last.textContent).toContain("2 hours ago");
    expect(last.textContent).toContain("4");
    expect(last.textContent).toContain("telegram: Forbidden");
  });

  it("starts with defaults when nothing is saved", async () => {
    digest = null;
    render(<Settings role="curator" />);
    await screen.findByRole("form", { name: "Daily review digest" });
    expect((screen.getByLabelText("Time zone") as HTMLSelectElement).value).toBe("America/Chicago");
    expect(input("Dashboard link").value).toBe(location.origin);
    expect(screen.queryByLabelText("SMTP host")).toBeNull();
    expect((screen.getByRole("button", { name: "Send test" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("leaves a blank secret out of the PUT, and sends a typed one", async () => {
    render(<Settings role="curator" />);
    await screen.findByRole("form", { name: "Daily review digest" });
    type("Bot token", "123:new-token");
    save();
    await screen.findByRole("status");
    expect(puts).toEqual([
      {
        enabled: true,
        time: "07:30",
        timezone: "Europe/Berlin",
        dashboard_url: "https://hive.example.com",
        email: {
          smtp_host: "smtp.example.com",
          smtp_port: 587,
          smtp_secure: false,
          smtp_user: "hive",
          from: "hive@example.com",
          to: ["jon@example.com", "ann@example.com"],
        },
        telegram: { bot_token: "123:new-token", chat_id: "-100123" },
      },
    ]);
    // Saved: the typed token is cleared again.
    await waitFor(() => expect(input("Bot token").value).toBe(""));
  });

  it("leaves a channel that is off out of the PUT", async () => {
    render(<Settings role="curator" />);
    await screen.findByRole("form", { name: "Daily review digest" });
    fireEvent.click(screen.getByRole("switch", { name: "Send by email" }));
    expect(screen.queryByLabelText("SMTP host")).toBeNull();
    save();
    await screen.findByRole("status");
    expect(puts).toHaveLength(1);
    expect(puts[0]).not.toHaveProperty("email");
    expect(puts[0]).toHaveProperty("telegram", { chat_id: "-100123" });
  });

  it("shows the hive's error when saving fails", async () => {
    putAnswer = () => json({ error: "unknown timezone: Mars/Olympus" }, 400);
    render(<Settings role="curator" />);
    await screen.findByRole("form", { name: "Daily review digest" });
    save();
    expect((await screen.findByRole("alert")).textContent).toBe("unknown timezone: Mars/Olympus");
    putAnswer = () => json({ error: "HIVE_SECRET_KEY is not set" }, 503);
    save();
    await waitFor(() => expect(screen.getByRole("alert").textContent).toBe("HIVE_SECRET_KEY is not set"));
  });

  it("sends a test and shows each channel's result; not while there are unsaved changes", async () => {
    render(<Settings role="curator" />);
    await screen.findByRole("form", { name: "Daily review digest" });
    const button = screen.getByRole("button", { name: "Send test" }) as HTMLButtonElement;
    type("Chat id", "-100999");
    expect(button.disabled).toBe(true);
    screen.getByText("Save first to send a test.");
    type("Chat id", "-100123");
    expect(button.disabled).toBe(false);

    fireEvent.click(button);
    const results = await screen.findByRole("list", { name: "Test results" });
    const items = within(results).getAllByRole("listitem");
    expect(items.map((li) => li.textContent)).toEqual(["Email ✓ Sent", "Telegram ✗ FailedUnauthorized"]);
    expect(fetchMock.mock.calls.some(([u, i]) => String(u) === "/v1/review-digest/test" && i?.method === "POST")).toBe(true);
  });

  it("a member sees a note and no form", () => {
    render(<Settings role="member" />);
    expect(screen.getByRole("note").textContent).toBe("Only a curator can change settings.");
    expect(screen.queryByRole("form")).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("only curators get Admin's Notifications tab", async () => {
    sessionStorage.setItem("hive.token", "t");
    role = "member";
    history.replaceState(null, "", "/repos");
    render(<App />);
    await screen.findByRole("link", { name: "Admin" });
    expect(screen.queryByRole("link", { name: "Notifications" })).toBeNull();
    cleanup();

    role = "curator";
    history.replaceState(null, "", "/repos");
    render(<App />);
    fireEvent.click(await screen.findByRole("link", { name: "Notifications" }));
    expect(location.pathname).toBe("/settings");
    await screen.findByRole("form", { name: "Daily review digest" });
  });
});
