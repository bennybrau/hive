import { useEffect, useState } from "react";
import { apiFetch, type Role } from "../api";
import { Badge, PageHeader } from "../ui";
import { JOB, levelLabel, ORIGIN, ROLE, STATUS, when, word, type Word } from "../words";

interface CostRow {
  job: string;
  calls: number;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
}

export interface StatsBody {
  days: number;
  since: string;
  facts: {
    by_status: Record<string, number>;
    by_origin: Record<string, number>;
    by_scope: Record<string, number>;
    per_day: { day: string; count: number }[];
  };
  cost: (CostRow & { day: string })[];
  cost_totals: CostRow[];
  workers: { id: string; name: string; last_seen_at: string | null }[];
  backlog: {
    candidates: number;
    oldest_candidate_at: string | null;
    distill_queued: number;
    oldest_queued_at: string | null;
  };
}

const RANGES = [7, 30, 90];
/** A worker not seen for this long is flagged. */
const STALE_MS = 10 * 60_000;

export const usd = (n: number) => `$${n.toFixed(2)}`;
const num = (n: number) => n.toLocaleString("en");

/** A `YYYY-MM-DD` day as "Nov 1" (or "Nov 1, 2025" before this year); the full date as a hover. */
function Day({ day }: { day: string }) {
  const d = new Date(`${day}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return <>{day}</>;
  const sameYear = d.getUTCFullYear() === new Date().getUTCFullYear();
  const text = d.toLocaleDateString("en-US", { timeZone: "UTC", month: "short", day: "numeric", ...(sameYear ? {} : { year: "numeric" }) });
  return (
    <time dateTime={day} title={d.toLocaleDateString("en-US", { timeZone: "UTC", dateStyle: "long" })}>
      {text}
    </time>
  );
}

function When({ iso }: { iso: string }) {
  const w = when(iso);
  return (
    <time dateTime={iso} title={w.title}>
      {w.text}
    </time>
  );
}

/** A `by_scope` key in words; every personal scope arrives folded into `personal`. */
const scopeWord = (k: string): Word => levelLabel({ scope: k === "personal" ? "personal:" : k });

function CostTable({ label, rows, byDay }: { label: string; rows: (CostRow & { day?: string })[]; byDay?: boolean }) {
  if (rows.length === 0) return <p className="help">No LLM calls in this window.</p>;
  return (
    <table className="stats" aria-label={label}>
      <thead>
        <tr>
          {byDay && <th>Day</th>}
          <th>Job</th>
          <th className="num">Calls</th>
          <th className="num">Input tokens</th>
          <th className="num">Output tokens</th>
          <th className="num">Cost</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={`${r.day ?? ""}/${r.job}`}>
            {byDay && (
              <td>
                <Day day={r.day!} />
              </td>
            )}
            <td title={word(JOB, r.job).hint || undefined}>{word(JOB, r.job).label}</td>
            <td className="num">{num(r.calls)}</td>
            <td className="num">{num(r.input_tokens)}</td>
            <td className="num">{num(r.output_tokens)}</td>
            <td className="num">{usd(r.cost_usd)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Counts({ label, counts, words }: { label: string; counts: Record<string, number>; words: (k: string) => Word }) {
  const entries = Object.entries(counts);
  return (
    <table className="stats" aria-label={label}>
      <thead>
        <tr>
          <th>{label}</th>
          <th className="num">Facts</th>
        </tr>
      </thead>
      <tbody>
        {entries.length === 0 ? (
          <tr>
            <td colSpan={2} className="help">
              None.
            </td>
          </tr>
        ) : (
          entries.map(([k, v]) => (
            <tr key={k}>
              <td title={words(k).hint || undefined}>{words(k).label}</td>
              <td className="num">{num(v)}</td>
            </tr>
          ))
        )}
      </tbody>
    </table>
  );
}

/** Curator overview: what the hive's LLM calls cost, how many facts there are, and what is waiting. */
export function Stats({ role }: { role: Role }) {
  if (role !== "curator") {
    return (
      <main className="page">
        <PageHeader title="Usage and cost" />
        <p className="help" role="note" title={ROLE.curator!.hint}>
          Only a Curator can see usage and cost.
        </p>
      </main>
    );
  }
  return <StatsPage />;
}

function StatsPage() {
  const [days, setDays] = useState(30);
  const [stats, setStats] = useState<StatsBody | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setError(null);
    apiFetch(`/v1/stats?days=${days}`)
      .then(async (res) => {
        if (!res.ok) throw new Error(`The hive answered ${res.status}.`);
        return (await res.json()) as StatsBody;
      })
      .then((s) => live && setStats(s))
      .catch((err: unknown) => live && setError(err instanceof Error ? err.message : "Couldn't load stats."));
    return () => {
      live = false;
    };
  }, [days]);

  const now = Date.now();
  return (
    <main className="page stats-page">
      <PageHeader title="Usage and cost" lede="What Hive spent, what it learned, and whether its background jobs are keeping up." />
      <div className="chips" role="group" aria-label="Window">
        {RANGES.map((d) => (
          <button key={d} type="button" aria-pressed={days === d} onClick={() => setDays(d)}>
            {d} days
          </button>
        ))}
      </div>

      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {!stats && !error && <p className="help">Loading…</p>}

      {stats && (
        <>
          <section aria-labelledby="stats-cost">
            <h2 id="stats-cost">Cost</h2>
            <CostTable label="Cost by job" rows={stats.cost_totals} />
            {stats.cost.length > 0 && <CostTable label="Cost by day" rows={stats.cost} byDay />}
          </section>

          <section aria-labelledby="stats-facts">
            <h2 id="stats-facts">Facts</h2>
            <div className="stats-row">
              <Counts label="Status" counts={stats.facts.by_status} words={(k) => word(STATUS, k)} />
              <Counts label="Origin" counts={stats.facts.by_origin} words={(k) => word(ORIGIN, k)} />
              <Counts label="Who gets it" counts={stats.facts.by_scope} words={scopeWord} />
            </div>
            {stats.facts.per_day.length === 0 ? (
              <p className="help">No facts recorded in this window.</p>
            ) : (
              <table className="stats" aria-label="Facts by day">
                <thead>
                  <tr>
                    <th>Day</th>
                    <th className="num">Recorded</th>
                  </tr>
                </thead>
                <tbody>
                  {stats.facts.per_day.map((r) => (
                    <tr key={r.day}>
                      <td>
                        <Day day={r.day} />
                      </td>
                      <td className="num">{num(r.count)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>

          <section aria-labelledby="stats-workers">
            <h2 id="stats-workers">Workers</h2>
            {stats.workers.length === 0 ? (
              <p className="help">No worker tokens.</p>
            ) : (
              <table className="stats" aria-label="Workers">
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Last seen</th>
                  </tr>
                </thead>
                <tbody>
                  {stats.workers.map((w) => {
                    const stale = !w.last_seen_at || now - Date.parse(w.last_seen_at) > STALE_MS;
                    return (
                      <tr key={w.id}>
                        <td>{w.name}</td>
                        <td>
                          {w.last_seen_at ? <When iso={w.last_seen_at} /> : "Never"}{" "}
                          {stale && (
                            <Badge tone="warn" title="Not seen in the last 10 minutes">
                              Not running?
                            </Badge>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </section>

          <section aria-labelledby="stats-backlog">
            <h2 id="stats-backlog">Backlog</h2>
            <table className="stats" aria-label="Backlog">
              <tbody>
                <tr>
                  <th>Facts waiting for review</th>
                  <td className="num">{num(stats.backlog.candidates)}</td>
                  <td className="help">
                    {stats.backlog.oldest_candidate_at && (
                      <>
                        oldest <When iso={stats.backlog.oldest_candidate_at} />
                      </>
                    )}
                  </td>
                </tr>
                <tr>
                  <th>Conversations waiting to be read</th>
                  <td className="num">{num(stats.backlog.distill_queued)}</td>
                  <td className="help">
                    {stats.backlog.oldest_queued_at && (
                      <>
                        oldest <When iso={stats.backlog.oldest_queued_at} />
                      </>
                    )}
                  </td>
                </tr>
              </tbody>
            </table>
          </section>
        </>
      )}
    </main>
  );
}
