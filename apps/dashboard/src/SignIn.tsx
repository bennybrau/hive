import { useState, type FormEvent } from "react";
import { ApiError, checkToken, setToken, type Status } from "./api";

export function SignIn({ onSignedIn }: { onSignedIn: (status: Status) => void }) {
  const [token, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const t = token.trim();
    if (!t) return;
    setBusy(true);
    setError(null);
    try {
      const status = await checkToken(t);
      setToken(t);
      onSignedIn(status);
    } catch (err) {
      setError(
        err instanceof ApiError && err.status === 401
          ? "The hive didn't accept that token."
          : "Couldn't reach the hive. Try again.",
      );
      setBusy(false);
    }
  }

  return (
    <main className="signin">
      <form onSubmit={submit}>
        <h1>hive</h1>
        <label htmlFor="token">Token</label>
        <input
          id="token"
          type="password"
          autoComplete="off"
          spellCheck={false}
          value={token}
          onChange={(e) => setValue(e.target.value)}
          aria-describedby={error ? "token-error" : "token-help"}
          aria-invalid={error ? true : undefined}
        />
        {error ? (
          <p id="token-error" className="error" role="alert">
            {error}
          </p>
        ) : (
          <p id="token-help" className="help">
            Paste a token from <code>mint-token</code>. It's kept for this tab only.
          </p>
        )}
        <button type="submit" disabled={busy || !token.trim()}>
          {busy ? "Checking…" : "Sign in"}
        </button>
      </form>
    </main>
  );
}
