import { useEffect, useState } from "react";
import { apiFetch } from "../api";
import { githubBlobUrl } from "./github";
import type { Fact } from "./query";

interface Anchor {
  id: string;
  episode_id: string | null;
  repo_key: string | null;
  commit_sha: string | null;
  path: string | null;
  line_start: number | null;
  line_end: number | null;
  quote: string | null;
  verify_status: string;
  verified_at: string | null;
  verify_note: string | null;
  found_line: number | null;
  remote_url: string | null;
}

interface ChainLink {
  id: string;
  text: string;
  status: string;
  recorded_at: string;
}

interface Review {
  action: string;
  note: string | null;
  new_text: string | null;
  reviewer_user_id: string | null;
  created_at: string;
}

interface Detail {
  fact: Fact;
  anchors: Anchor[];
  reviews: Review[];
  supersedes: ChainLink[];
  superseded_by: ChainLink[];
}

function lines(a: Anchor): string {
  if (!a.line_start) return "";
  return a.line_end && a.line_end !== a.line_start ? `:${a.line_start}-${a.line_end}` : `:${a.line_start}`;
}

function Chain({ title, links, onOpen }: { title: string; links: ChainLink[]; onOpen: (id: string) => void }) {
  if (links.length === 0) return null;
  return (
    <>
      <h3>{title}</h3>
      <ul className="chain">
        {links.map((l) => (
          <li key={l.id}>
            <a
              href={`/facts/${l.id}`}
              onClick={(e) => {
                e.preventDefault();
                onOpen(l.id);
              }}
            >
              {l.text}
            </a>{" "}
            <span className="help">({l.status})</span>
          </li>
        ))}
      </ul>
    </>
  );
}

export function FactDetail({ id, onClose, onOpen }: { id: string; onClose: () => void; onOpen: (id: string) => void }) {
  const [detail, setDetail] = useState<Detail | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setDetail(null);
    setError(null);
    apiFetch(`/v1/facts/${encodeURIComponent(id)}`)
      .then(async (res) => {
        if (res.status === 404) throw new Error("No such fact, or it isn't yours to read.");
        if (!res.ok) throw new Error(`The hive answered ${res.status}.`);
        return (await res.json()) as Detail;
      })
      .then((d) => live && setDetail(d))
      .catch((err: unknown) => live && setError(err instanceof Error ? err.message : "Couldn't load the fact."));
    return () => {
      live = false;
    };
  }, [id]);

  const f = detail?.fact;
  return (
    <aside className="fact-detail" aria-label="Fact detail">
      <header>
        <h2>Fact</h2>
        <button type="button" onClick={onClose}>
          Close
        </button>
      </header>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {!detail && !error && <p className="help">Loading…</p>}
      {detail && f && (
        <>
          <p className="fact-text">{f.text}</p>

          <h3>Provenance</h3>
          <dl>
            <dt>Kind</dt>
            <dd>{f.kind}</dd>
            <dt>Scope</dt>
            <dd>{f.scope}</dd>
            <dt>Status</dt>
            <dd>
              {f.status}
              {f.status_note && <span className="help"> — {f.status_note}</span>}
            </dd>
            <dt>Origin</dt>
            <dd>{f.origin}</dd>
            <dt>Author</dt>
            <dd>{f.author_user_id ?? "—"}</dd>
            <dt>Recorded</dt>
            <dd>
              <time dateTime={f.recorded_at}>{f.recorded_at}</time>
            </dd>
            {f.locus.length > 0 && (
              <>
                <dt>Locus</dt>
                <dd>
                  {f.locus.map((l) => (
                    <code key={l}>{l} </code>
                  ))}
                </dd>
              </>
            )}
          </dl>

          <h3>Anchors</h3>
          {detail.anchors.length === 0 ? (
            <p className="help">None.</p>
          ) : (
            <ul className="anchors">
              {detail.anchors.map((a) => {
                const href = githubBlobUrl(a.remote_url, a.commit_sha, a.path, a.line_start, a.line_end);
                const moved = a.found_line != null && a.found_line !== a.line_start;
                return (
                  <li key={a.id}>
                    <span className={`badge verify-${a.verify_status}`}>{a.verify_status.replace(/_/g, " ")}</span>{" "}
                    {a.path ? (
                      <code>
                        {a.repo_key ? `${a.repo_key} ` : ""}
                        {a.path}
                        {lines(a)}
                      </code>
                    ) : a.episode_id ? (
                      <span>episode {a.episode_id}</span>
                    ) : null}
                    {a.commit_sha && <code className="help"> @{a.commit_sha.slice(0, 10)}</code>}
                    {href && (
                      <>
                        {" "}
                        <a href={href} target="_blank" rel="noreferrer">
                          View on GitHub
                        </a>
                      </>
                    )}
                    {moved && <p className="help">Now found at line {a.found_line}.</p>}
                    {a.verify_note && <p className="help">{a.verify_note}</p>}
                    {a.quote && <pre className="quote">{a.quote}</pre>}
                  </li>
                );
              })}
            </ul>
          )}

          <Chain title="Supersedes" links={detail.supersedes} onOpen={onOpen} />
          <Chain title="Superseded by" links={detail.superseded_by} onOpen={onOpen} />

          <h3>Reviews</h3>
          {detail.reviews.length === 0 ? (
            <p className="help">None.</p>
          ) : (
            <ul className="reviews">
              {detail.reviews.map((r, i) => (
                <li key={i}>
                  <strong>{r.action}</strong> by {r.reviewer_user_id ?? "—"}{" "}
                  <time className="help" dateTime={r.created_at}>
                    {r.created_at.slice(0, 10)}
                  </time>
                  {r.note && <p>{r.note}</p>}
                  {r.new_text && <p className="help">New text: {r.new_text}</p>}
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </aside>
  );
}
