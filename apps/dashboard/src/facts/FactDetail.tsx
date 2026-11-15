import { useEffect, useState } from "react";
import { apiFetch } from "../api";
import { useTeams } from "../levels/levels";
import { Badge, Button } from "../ui";
import { KIND, levelLabel, PHRASE, REVIEW, saidCaption, STATUS, usedLine, VERIFY, when, word } from "../words";
import { FactActions } from "./FactActions";
import { githubBlobUrl } from "./github";
import type { Fact } from "./query";
import type { Me } from "./useMe";

interface Source {
  kind: string;
  author: string | null;
  where: string;
  at: string;
}

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
  /** Who said it, where and when; null for a file anchor or an episode that isn't a person's words. */
  source?: Source | null;
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

/** One entry per distinct quote that isn't from a file; the caption comes from the first of them that has a source. */
function quotes(anchors: Anchor[]): { quote: string; anchor: Anchor }[] {
  const out: { quote: string; anchor: Anchor }[] = [];
  for (const a of anchors) {
    if (a.path || !a.quote) continue;
    const seen = out.find((q) => q.quote === a.quote);
    if (!seen) out.push({ quote: a.quote, anchor: a });
    else if (!seen.anchor.source && a.source) seen.anchor = a;
  }
  return out;
}

function Chain({ title, links, onOpen }: { title: string; links: ChainLink[]; onOpen: (id: string) => void }) {
  if (links.length === 0) return null;
  return (
    <div className="chain">
      <h3>{title}</h3>
      <ul>
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
            <span className="help">({word(STATUS, l.status).label})</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function When({ iso, full }: { iso: string; full?: boolean }) {
  const t = when(iso);
  return (
    <time dateTime={iso} title={t.title}>
      {full ? t.title : t.text}
    </time>
  );
}

/** "By <who>, <when>"; just the time when nobody is named. */
function By({ who, iso }: { who: string | null; iso: string }) {
  return (
    <>
      {who && `By ${who[0]!.toUpperCase()}${who.slice(1)}, `}
      <When iso={iso} />
    </>
  );
}

/**
 * The open fact: who gets it and its state, the fact, what was said (or the file), three plain lines, its actions, the
 * chain, then Details. After a save, `onReplace` opens the fact that took its place (a new wording, or a merge), or the
 * pane reloads; either way `onSaved` tells the list.
 */
export function FactDetail({
  id,
  me,
  onClose,
  onOpen,
  onReplace,
  onSaved,
}: {
  id: string;
  me: Me | null;
  onClose: () => void;
  onOpen: (id: string) => void;
  onReplace: (id: string) => void;
  onSaved: () => void;
}) {
  const [detail, setDetail] = useState<Detail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const { teams, mine } = useTeams();

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
  }, [id, reload]);

  const f = detail?.fact;
  const who = f && levelLabel(f, teams, mine);
  const approval = detail?.reviews.filter((r) => r.action === "approve" || r.action === "fix").at(-1);
  const files = detail?.anchors.filter((a) => a.path) ?? [];
  const conversations = [...new Set(detail?.anchors.map((a) => a.episode_id).filter((e): e is string => !!e))];
  return (
    <aside className="kn-pane" aria-label={PHRASE.selectedFact}>
      <div className="pane-top">
        {f && who && (
          <>
            <Badge tone="who" title={f.scope}>
              {who.label}
            </Badge>
            <Badge title={word(KIND, f.kind).hint || undefined}>{word(KIND, f.kind).label}</Badge>
            <Badge title={word(STATUS, f.status).hint || undefined}>{word(STATUS, f.status).label}</Badge>
          </>
        )}
        <Button variant="quiet" className="close" aria-label={PHRASE.close} onClick={onClose}>
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M6 6l12 12M18 6L6 18" />
          </svg>
        </Button>
      </div>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {!detail && !error && <p className="help">Loading…</p>}
      {detail && f && who && (
        <>
          <p className="bigfact">{f.text}</p>

          {quotes(detail.anchors).map(({ quote, anchor: a }) => (
            <figure className="said" key={quote}>
              <blockquote>{quote}</blockquote>
              <figcaption>
                {a.source && <span>{saidCaption(a.source)}</span>}
                <span className="check" title={word(VERIFY, a.verify_status).hint || undefined}>
                  {word(VERIFY, a.verify_status).label}
                </span>
              </figcaption>
            </figure>
          ))}

          {files.length > 0 && (
            <ul className="files" aria-label={PHRASE.anchors}>
              {files.map((a) => {
                const href = githubBlobUrl(a.remote_url, a.commit_sha, a.path, a.line_start, a.line_end);
                const moved = a.found_line != null && a.found_line !== a.line_start;
                return (
                  <li key={a.id}>
                    <span className={`badge verify-${a.verify_status}`} title={word(VERIFY, a.verify_status).hint || undefined}>
                      {word(VERIFY, a.verify_status).label}
                    </span>{" "}
                    <code>
                      {a.repo_key ? `${a.repo_key} ` : ""}
                      {a.path}
                      {lines(a)}
                    </code>
                    {a.commit_sha && <code className="help"> @{a.commit_sha.slice(0, 7)}</code>}
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

          <dl className="kv">
            <dt>{PHRASE.whoGetsIt}</dt>
            <dd>{who.hint}</dd>
            {f.use_count !== undefined && (
              <>
                <dt>{PHRASE.used}</dt>
                <dd>{usedLine(f.use_count, f.last_used_at)}</dd>
              </>
            )}
            {f.origin === "distilled" && approval && (
              <>
                <dt>{PHRASE.approved}</dt>
                <dd>
                  <By who={approval.reviewer_user_id} iso={approval.created_at} />
                </dd>
              </>
            )}
            {f.origin === "authored" && (
              <>
                <dt>{PHRASE.written}</dt>
                <dd>
                  <By who={f.author_user_id} iso={f.recorded_at} />
                </dd>
              </>
            )}
            {(f.status === "retracted" || f.status === "superseded") && f.status_note && (
              <>
                <dt>{word(STATUS, f.status).label}</dt>
                <dd>{f.status_note}</dd>
              </>
            )}
          </dl>

          {me && (
            <FactActions
              key={f.id}
              fact={f}
              anchorRepo={detail.anchors[0]?.repo_key ?? null}
              teams={teams}
              mine={mine}
              me={me}
              onSaved={(next) => {
                if (next && next !== f.id) onReplace(next);
                else setReload((r) => r + 1);
                onSaved();
              }}
            />
          )}

          <Chain title={PHRASE.replaces} links={detail.supersedes} onOpen={onOpen} />
          <Chain title={PHRASE.replacedBy} links={detail.superseded_by} onOpen={onOpen} />

          <details className="more">
            <summary>{PHRASE.provenance}</summary>
            <dl className="kv">
              <dt>Id</dt>
              <dd>
                <code>{f.id}</code>
              </dd>
              <dt>Recorded</dt>
              <dd>
                <When iso={f.recorded_at} full />
              </dd>
              <dt>Author</dt>
              <dd>{f.author_user_id ?? "—"}</dd>
              {conversations.length > 0 && (
                <>
                  <dt>{conversations.length === 1 ? "Conversation" : "Conversations"}</dt>
                  <dd>
                    {conversations.map((c, i) => (
                      <span key={c}>
                        {i > 0 && ", "}
                        <code>{c}</code>
                      </span>
                    ))}
                  </dd>
                </>
              )}
              {detail.reviews.length > 0 && (
                <>
                  <dt>History</dt>
                  <dd>
                    <ul className="history">
                      {detail.reviews.map((r, i) => (
                        <li key={i}>
                          {word(REVIEW, r.action).label}
                          {r.reviewer_user_id && ` by ${r.reviewer_user_id}`}, <When iso={r.created_at} full />
                          {r.note && (
                            <>
                              {" — "}
                              <span className="help">{r.note}</span>
                            </>
                          )}
                          {r.new_text && <p className="help">New text: {r.new_text}</p>}
                        </li>
                      ))}
                    </ul>
                  </dd>
                </>
              )}
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
          </details>
        </>
      )}
    </aside>
  );
}
