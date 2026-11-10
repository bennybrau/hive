import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import { apiFetch, type Role } from "../api";
import { splitList } from "../playbooks/PlaybookForm";
import { timeAgo } from "../review/Review";

/** `review_digest` from GET /v1/settings. Never holds the SMTP password or bot token. */
export interface DigestView {
  enabled: boolean;
  time: string;
  timezone: string;
  dashboard_url: string;
  channels: {
    email: { smtp_host: string; smtp_port: number; smtp_secure: boolean; smtp_user: string; from: string; to: string[] } | null;
    telegram: { chat_id: string } | null;
  };
  last_sent_at: string | null;
  last_item_count: number | null;
  last_error: string | null;
}

type ChannelResult = { status: "sent"; error: null } | { status: "failed"; error: string };
export type TestResult = { email?: ChannelResult; telegram?: ChannelResult };

/** The form's fields; secrets are blank unless being replaced. */
interface Draft {
  enabled: boolean;
  time: string;
  timezone: string;
  dashboard_url: string;
  emailOn: boolean;
  smtp_host: string;
  smtp_port: string;
  smtp_secure: boolean;
  smtp_user: string;
  smtp_pass: string;
  from: string;
  to: string;
  telegramOn: boolean;
  bot_token: string;
  chat_id: string;
}

function draftFrom(v: DigestView | null): Draft {
  const e = v?.channels.email;
  return {
    enabled: v?.enabled ?? false,
    time: v?.time ?? "18:00",
    timezone: v?.timezone ?? "America/Chicago",
    dashboard_url: v?.dashboard_url ?? location.origin,
    emailOn: !!e,
    smtp_host: e?.smtp_host ?? "",
    smtp_port: String(e?.smtp_port ?? 465),
    smtp_secure: e?.smtp_secure ?? true,
    smtp_user: e?.smtp_user ?? "",
    smtp_pass: "",
    from: e?.from ?? "",
    to: e?.to.join(", ") ?? "",
    telegramOn: !!v?.channels.telegram,
    bot_token: "",
    chat_id: v?.channels.telegram?.chat_id ?? "",
  };
}

/** The PUT body: a channel that is off is left out, and so is a blank secret (the hive keeps the stored one). */
function toBody(d: Draft) {
  return {
    enabled: d.enabled,
    time: d.time,
    timezone: d.timezone,
    dashboard_url: d.dashboard_url.trim(),
    ...(d.emailOn && {
      email: {
        smtp_host: d.smtp_host.trim(),
        smtp_port: Number(d.smtp_port),
        smtp_secure: d.smtp_secure,
        smtp_user: d.smtp_user.trim(),
        ...(d.smtp_pass && { smtp_pass: d.smtp_pass }),
        from: d.from.trim(),
        to: splitList(d.to),
      },
    }),
    ...(d.telegramOn && {
      telegram: { ...(d.bot_token.trim() && { bot_token: d.bot_token.trim() }), chat_id: d.chat_id.trim() },
    }),
  };
}

async function errorText(res: Response): Promise<string> {
  try {
    const { error } = (await res.json()) as { error?: string };
    if (error) return error;
  } catch {
    // not JSON: the status says enough
  }
  return `The hive answered ${res.status}.`;
}

async function loadDigest(): Promise<DigestView | null> {
  const res = await apiFetch("/v1/settings");
  if (!res.ok) throw new Error(`The hive answered ${res.status}.`);
  return ((await res.json()) as { review_digest: DigestView | null }).review_digest;
}

/** Service settings. Today only the daily review digest, and only for curators. */
export function Settings({ role }: { role: Role }) {
  if (role !== "curator") {
    return (
      <main className="page">
        <h1>Settings</h1>
        <p className="help" role="note">
          Only a curator can change settings.
        </p>
      </main>
    );
  }
  return <SettingsPage />;
}

function SettingsPage() {
  const [view, setView] = useState<DigestView | null | undefined>(undefined);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    loadDigest()
      .then((v) => live && setView(v))
      .catch((err: unknown) => live && setLoadError(err instanceof Error ? err.message : "Couldn't load settings."));
    return () => {
      live = false;
    };
  }, []);

  return (
    <main className="page settings-page">
      <h1>Settings</h1>
      {loadError && (
        <p className="error" role="alert">
          {loadError}
        </p>
      )}
      {view === undefined && !loadError && <p className="help">Loading…</p>}
      {view !== undefined && <DigestForm view={view} onSaved={setView} />}
    </main>
  );
}

function Field({ id, label, help, children }: { id: string; label: string; help?: ReactNode; children: ReactNode }) {
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      {children}
      {help && <p className="help">{help}</p>}
    </div>
  );
}

function DigestForm({ view, onSaved }: { view: DigestView | null; onSaved: (v: DigestView | null) => void }) {
  const saved = useMemo(() => draftFrom(view), [view]);
  const [draft, setDraft] = useState(saved);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  const [test, setTest] = useState<TestResult | null>(null);
  const [testError, setTestError] = useState<string | null>(null);

  useEffect(() => setDraft(saved), [saved]);

  const zones = useMemo(() => {
    const all = Intl.supportedValuesOf("timeZone");
    return all.includes(draft.timezone) ? all : [draft.timezone, ...all];
  }, [draft.timezone]);

  const set = (patch: Partial<Draft>) => {
    setDraft((d) => ({ ...d, ...patch }));
    setNotice(null);
  };
  const dirty = JSON.stringify(draft) !== JSON.stringify(saved);
  const hasChannel = !!(view?.channels.email || view?.channels.telegram);

  async function save(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const res = await apiFetch("/v1/settings/review-digest", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(toBody(draft)),
      });
      if (!res.ok) throw new Error(await errorText(res));
      onSaved(await loadDigest());
      setNotice("Saved.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't save the settings.");
    } finally {
      setSaving(false);
    }
  }

  async function sendTest() {
    setTesting(true);
    setTest(null);
    setTestError(null);
    try {
      const res = await apiFetch("/v1/review-digest/test", { method: "POST" });
      if (!res.ok) throw new Error(await errorText(res));
      setTest((await res.json()) as TestResult);
    } catch (err) {
      setTestError(err instanceof Error ? err.message : "Couldn't send the test.");
    } finally {
      setTesting(false);
    }
  }

  return (
    <form className="settings-form" onSubmit={save} aria-label="Daily review digest">
      <h2>Daily review digest</h2>
      <p className="help">Once a day, a short list of what is waiting in Review, by email, Telegram or both.</p>

      <label className="toggle">
        <input type="checkbox" role="switch" checked={draft.enabled} onChange={(e) => set({ enabled: e.target.checked })} />
        Send the daily digest
      </label>

      <div className="settings-row">
        <Field id="sd-time" label="Time">
          <input id="sd-time" type="time" required value={draft.time} onChange={(e) => set({ time: e.target.value })} />
        </Field>
        <Field id="sd-tz" label="Time zone">
          <select id="sd-tz" value={draft.timezone} onChange={(e) => set({ timezone: e.target.value })}>
            {zones.map((z) => (
              <option key={z} value={z}>
                {z}
              </option>
            ))}
          </select>
        </Field>
      </div>
      <Field id="sd-url" label="Dashboard link" help="Where the digest's links point.">
        <input id="sd-url" type="url" required value={draft.dashboard_url} onChange={(e) => set({ dashboard_url: e.target.value })} />
      </Field>

      <fieldset>
        <legend>Email</legend>
        <label className="toggle">
          <input type="checkbox" role="switch" checked={draft.emailOn} onChange={(e) => set({ emailOn: e.target.checked })} />
          Send by email
        </label>
        {draft.emailOn && (
          <>
            <div className="settings-row">
              <Field id="sd-host" label="SMTP host">
                <input id="sd-host" type="text" required value={draft.smtp_host} onChange={(e) => set({ smtp_host: e.target.value })} />
              </Field>
              <Field id="sd-port" label="SMTP port">
                <input
                  id="sd-port"
                  type="number"
                  inputMode="numeric"
                  required
                  min={1}
                  max={65535}
                  value={draft.smtp_port}
                  onChange={(e) => set({ smtp_port: e.target.value })}
                />
              </Field>
            </div>
            <label className="toggle">
              <input type="checkbox" checked={draft.smtp_secure} onChange={(e) => set({ smtp_secure: e.target.checked })} />
              Secure connection (TLS from the start, usually port 465)
            </label>
            <div className="settings-row">
              <Field id="sd-user" label="SMTP user">
                <input
                  id="sd-user"
                  type="text"
                  required
                  autoComplete="off"
                  value={draft.smtp_user}
                  onChange={(e) => set({ smtp_user: e.target.value })}
                />
              </Field>
              <Field id="sd-pass" label="SMTP password" help={view?.channels.email ? "Leave blank to keep the saved one." : undefined}>
                <input
                  id="sd-pass"
                  type="password"
                  autoComplete="new-password"
                  required={!view?.channels.email}
                  placeholder={view?.channels.email ? "saved" : undefined}
                  value={draft.smtp_pass}
                  onChange={(e) => set({ smtp_pass: e.target.value })}
                />
              </Field>
            </div>
            <Field id="sd-from" label="From">
              <input id="sd-from" type="email" required value={draft.from} onChange={(e) => set({ from: e.target.value })} />
            </Field>
            <Field id="sd-to" label="To" help="Comma separated, up to 10.">
              <input id="sd-to" type="text" required value={draft.to} onChange={(e) => set({ to: e.target.value })} />
            </Field>
          </>
        )}
      </fieldset>

      <fieldset>
        <legend>Telegram</legend>
        <label className="toggle">
          <input type="checkbox" role="switch" checked={draft.telegramOn} onChange={(e) => set({ telegramOn: e.target.checked })} />
          Send by Telegram
        </label>
        {draft.telegramOn && (
          <div className="settings-row">
            <Field id="sd-token" label="Bot token" help={view?.channels.telegram ? "Leave blank to keep the saved one." : undefined}>
              <input
                id="sd-token"
                type="password"
                autoComplete="new-password"
                required={!view?.channels.telegram}
                placeholder={view?.channels.telegram ? "saved" : undefined}
                value={draft.bot_token}
                onChange={(e) => set({ bot_token: e.target.value })}
              />
            </Field>
            <Field id="sd-chat" label="Chat id">
              <input id="sd-chat" type="text" required value={draft.chat_id} onChange={(e) => set({ chat_id: e.target.value })} />
            </Field>
          </div>
        )}
      </fieldset>

      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <div className="settings-actions">
        <button type="submit" disabled={saving}>
          {saving ? "Saving…" : "Save"}
        </button>
        <button type="button" disabled={dirty || !hasChannel || testing} onClick={sendTest}>
          {testing ? "Sending…" : "Send test"}
        </button>
        {notice && (
          <span className="help" role="status">
            {notice}
          </span>
        )}
        {dirty && <span className="help">Save first to send a test.</span>}
      </div>

      {testError && (
        <p className="error" role="alert">
          {testError}
        </p>
      )}
      {test && (
        <ul className="settings-results" aria-label="Test results">
          {(["email", "telegram"] as const).map((ch) => {
            const r = test[ch];
            if (!r) return null;
            return (
              <li key={ch} data-channel={ch} data-status={r.status}>
                <strong>{ch === "email" ? "Email" : "Telegram"}</strong>{" "}
                <span aria-hidden="true">{r.status === "sent" ? "✓" : "✗"}</span> {r.status === "sent" ? "Sent" : "Failed"}
                {r.error && <span className="error">{r.error}</span>}
              </li>
            );
          })}
        </ul>
      )}

      {view && (
        <dl className="settings-last" aria-label="Last digest">
          <dt>Last sent</dt>
          <dd>{view.last_sent_at ? timeAgo(view.last_sent_at) : "never"}</dd>
          <dt>Items</dt>
          <dd>{view.last_item_count ?? "none yet"}</dd>
          <dt>Last error</dt>
          <dd>{view.last_error ?? "none"}</dd>
        </dl>
      )}
    </form>
  );
}
