import { useEffect, useState, type FormEvent } from "react";
import { apiFetch, type Role } from "../api";
import { Badge, Button, EmptyState, Field, PageHeader } from "../ui";
import { ROLE, when, word } from "../words";

/** One bearer token, as GET /v1/instances lists it. */
export interface Instance {
  id: string;
  name: string;
  user_id: string;
  role: Role;
  created_at: string;
  last_seen_at: string | null;
  revoked_at: string | null;
  rotated_at: string | null;
}

/** A token the hive just handed out; it is never shown again. */
interface Fresh {
  name: string;
  token: string;
}

async function errorOf(res: Response): Promise<string> {
  const body = (await res.json().catch(() => null)) as { error?: string } | null;
  return body?.error ?? `The hive answered ${res.status}.`;
}

const ROLES: Role[] = ["member", "curator", "worker"];

function When({ iso }: { iso: string }) {
  const w = when(iso);
  return (
    <time dateTime={iso} title={w.title}>
      {w.text}
    </time>
  );
}

function CreateToken({ onCreated }: { onCreated: (i: Instance, token: string) => void }) {
  const [name, setName] = useState("");
  const [user, setUser] = useState("");
  const [role, setRole] = useState<Role>("member");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await apiFetch("/v1/instances", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: name.trim(), user_id: user.trim(), role }),
      });
      if (!res.ok) {
        setError(await errorOf(res));
        return;
      }
      const body = (await res.json()) as { instance: Instance; token: string };
      onCreated(body.instance, body.token);
      setName("");
      setUser("");
      setRole("member");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't create the token.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="tokens-create" aria-label="New token" onSubmit={(e) => void submit(e)}>
      <Field label="Name">{(p) => <input {...p} type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder="anas-laptop" />}</Field>
      <Field label="Person">{(p) => <input {...p} type="text" value={user} onChange={(e) => setUser(e.target.value)} placeholder="ana" />}</Field>
      <Field label="Role">
        {(p) => (
          <select {...p} value={role} onChange={(e) => setRole(e.target.value as Role)}>
            {ROLES.map((r) => (
              <option key={r} value={r}>
                {word(ROLE, r).label}
              </option>
            ))}
          </select>
        )}
      </Field>
      <Button type="submit" disabled={busy || !name.trim() || !user.trim()}>
        Create token
      </Button>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </form>
  );
}

/** The token just created or rotated: shown once, kept only in this page's state. */
function NewToken({ fresh, onDismiss }: { fresh: Fresh; onDismiss: () => void }) {
  const [copied, setCopied] = useState(false);
  return (
    <section className="tokens-new" aria-label="New token for this tab only">
      <Field label={`Token for ${fresh.name}`} help="You won't see this again.">
        {(p) => <input {...p} type="text" readOnly value={fresh.token} onFocus={(e) => e.currentTarget.select()} />}
      </Field>
      <Button
        onClick={() => {
          void navigator.clipboard?.writeText(fresh.token).then(() => setCopied(true));
        }}
      >
        {copied ? "Copied" : "Copy"}
      </Button>
      <Button variant="quiet" onClick={onDismiss}>
        Dismiss
      </Button>
    </section>
  );
}

function TokenRow({
  instance: i,
  self,
  onChanged,
  onFresh,
}: {
  instance: Instance;
  self: boolean;
  onChanged: (i: Instance) => void;
  onFresh: (f: Fresh) => void;
}) {
  const [confirm, setConfirm] = useState<"revoke" | "rotate" | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function act(action: "revoke" | "rotate") {
    setBusy(true);
    setError(null);
    try {
      const res = await apiFetch(`/v1/instances/${encodeURIComponent(i.id)}/${action}`, { method: "POST" });
      if (!res.ok) {
        setError(await errorOf(res));
        return;
      }
      const body = (await res.json()) as { instance: Instance; token?: string };
      onChanged(body.instance);
      if (body.token) onFresh({ name: body.instance.name, token: body.token });
      setConfirm(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : `Couldn't ${action} the token.`);
    } finally {
      setBusy(false);
    }
  }

  const revoked = i.revoked_at !== null;
  return (
    <tr data-id={i.id} className={revoked ? "revoked" : undefined}>
      <td>
        {i.name} {self && <Badge tone="who">you</Badge>}
      </td>
      <td>
        <code>{i.user_id}</code>
      </td>
      <td title={word(ROLE, i.role).hint || undefined}>{word(ROLE, i.role).label}</td>
      <td>
        {i.last_seen_at ? <When iso={i.last_seen_at} /> : "Never"}
        {i.rotated_at && (
          <span className="help">
            {" "}
            · rotated <When iso={i.rotated_at} />
          </span>
        )}
      </td>
      <td>
        <div className="tokens-actions">
        {revoked ? (
          <span className="help">
            Revoked <When iso={i.revoked_at!} />
          </span>
        ) : confirm ? (
          <>
            <span>
              {confirm === "revoke" ? "Revoke" : "Rotate"} {i.name}?
            </span>
            <Button className={confirm === "revoke" ? "danger" : undefined} disabled={busy} onClick={() => void act(confirm)}>
              Yes
            </Button>
            <Button variant="quiet" disabled={busy} onClick={() => setConfirm(null)}>
              Cancel
            </Button>
          </>
        ) : (
          <>
            <Button aria-label={`Rotate ${i.name}`} onClick={() => setConfirm("rotate")}>
              Rotate
            </Button>
            {self ? (
              <span className="help">you'll be signed out</span>
            ) : (
              <Button aria-label={`Revoke ${i.name}`} onClick={() => setConfirm("revoke")}>
                Revoke
              </Button>
            )}
          </>
        )}
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        </div>
      </td>
    </tr>
  );
}

/** /tokens (curators): every bearer token, and creating, rotating and revoking them. */
export function Tokens({ role, selfId }: { role: Role; selfId: string }) {
  if (role !== "curator") {
    return (
      <main className="page">
        <PageHeader title="Tokens" />
        <p className="help" role="note" title={ROLE.curator!.hint}>
          Only a Curator can manage tokens.
        </p>
      </main>
    );
  }
  return <TokensAdmin selfId={selfId} />;
}

function TokensAdmin({ selfId }: { selfId: string }) {
  const [instances, setInstances] = useState<Instance[] | null>(null);
  const [showRevoked, setShowRevoked] = useState(false);
  const [fresh, setFresh] = useState<Fresh | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setError(null);
    apiFetch(showRevoked ? "/v1/instances?revoked=true" : "/v1/instances")
      .then(async (res) => {
        if (!res.ok) throw new Error(`The hive answered ${res.status}.`);
        return ((await res.json()) as { instances: Instance[] }).instances;
      })
      .then((all) => live && setInstances(all))
      .catch((err: unknown) => live && setError(err instanceof Error ? err.message : "Couldn't load tokens."));
    return () => {
      live = false;
    };
  }, [showRevoked]);

  /** Replace a changed row in place; a revoked one leaves the list unless revoked rows are shown. */
  function put(i: Instance) {
    setInstances((all) => {
      const rest = all ?? [];
      if (i.revoked_at && !showRevoked) return rest.filter((x) => x.id !== i.id);
      return rest.some((x) => x.id === i.id) ? rest.map((x) => (x.id === i.id ? i : x)) : [...rest, i];
    });
  }

  return (
    <main className="page tokens-page">
      <PageHeader title="Tokens" lede="Each token signs in one agent, worker or person. Revoking one stops it at once." />
      <CreateToken
        onCreated={(i, token) => {
          put(i);
          setFresh({ name: i.name, token });
        }}
      />
      {fresh && <NewToken key={fresh.token} fresh={fresh} onDismiss={() => setFresh(null)} />}
      <label className="tokens-toggle">
        <input type="checkbox" checked={showRevoked} onChange={(e) => setShowRevoked(e.target.checked)} /> Show revoked
      </label>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {!instances && !error && <p className="help">Loading tokens…</p>}
      {instances && instances.length === 0 && <EmptyState title="No tokens">Create one above.</EmptyState>}
      {instances && instances.length > 0 && (
        <table className="stats tokens">
          <thead>
            <tr>
              <th>Name</th>
              <th>Person</th>
              <th>Role</th>
              <th>Last seen</th>
              <th aria-label="Actions" />
            </tr>
          </thead>
          <tbody>
            {instances.map((i) => (
              <TokenRow key={i.id} instance={i} self={i.id === selfId} onChanged={put} onFresh={setFresh} />
            ))}
          </tbody>
        </table>
      )}
    </main>
  );
}
