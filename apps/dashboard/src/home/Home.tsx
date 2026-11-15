import { useCallback, useEffect, useState, type ReactNode } from "react";
import { apiFetch, type Role } from "../api";
import { writeFilters, type Fact } from "../facts/query";
import { useTeams, type MyTeam, type Team } from "../levels/levels";
import { Badge, EmptyState, FactRow, Link, LinkButton, PageHeader } from "../ui";
import { KIND, count, dollars, greeting, levelLabel, usedTimes, when, word } from "../words";

/** GET /v1/home (docs/API.md § Home). The curator-only keys are missing for everyone else. */
export interface HomeData {
  facts: { live: number; by_level: { scope: string; count: number }[] };
  recent: Fact[];
  repos: { count: number; last_read_at: string | null; problems: number };
  teams: { count: number };
  waiting?: number;
  waiting_latest_at?: string | null;
  out_of_date?: number;
  stale_days?: number;
  month?: { cost_usd: number; conversations: number; proposed: number };
}

function Time({ iso }: { iso: string }) {
  const t = when(iso);
  return (
    <time dateTime={iso} title={t.title}>
      {t.text}
    </time>
  );
}

function Todo({ what, why, action, waiting }: { what: ReactNode; why: ReactNode; action: ReactNode; waiting?: boolean }) {
  return (
    <li className="todo" data-state={waiting ? "waiting" : undefined}>
      <div>
        <p className="what">{what}</p>
        <p className="why">{why}</p>
      </div>
      {action}
    </li>
  );
}

function NeedsYou({ data }: { data: HomeData }) {
  const waiting = data.waiting ?? 0;
  const stale = data.out_of_date ?? 0;
  const repos = data.repos;
  const facts = (n: number) => count(n, "fact", "facts");
  return (
    <section aria-labelledby="home-needs">
      <h2 id="home-needs">Needs you</h2>
      <ul className="todos">
        {waiting > 0 ? (
          <Todo
            waiting
            what={
              <>
                <b>{facts(waiting)}</b> {waiting === 1 ? "is" : "are"} waiting for review.
              </>
            }
            why={
              <>
                {data.waiting_latest_at && (
                  <>
                    {waiting === 1 ? "It is" : "The newest is"} from <Time iso={data.waiting_latest_at} />.{" "}
                  </>
                )}
                Agents don't get {waiting === 1 ? "it" : "them"} until you approve.
              </>
            }
            action={
              <LinkButton variant="primary" to="/review">
                Review {facts(waiting)}
              </LinkButton>
            }
          />
        ) : (
          <Todo
            what="Nothing is waiting for review."
            why="Hive proposes a fact when someone corrects an agent. Agents don't get it until a curator approves."
            action={<LinkButton to="/review">Open Review</LinkButton>}
          />
        )}
        <Todo
          what={
            stale > 0 ? (
              <>
                <b>{facts(stale)}</b> may be out of date.
              </>
            ) : (
              "No facts look out of date."
            )
          }
          why={`A fact nobody has used in ${data.stale_days ?? 60} days shows up here, so you can keep it or retire it.`}
          action={
            <LinkButton variant="quiet" to="/stale">
              See the list
            </LinkButton>
          }
        />
        <Todo
          what={
            repos.count === 0 ? (
              "Hive isn't reading any repos yet."
            ) : repos.problems > 0 ? (
              <>
                <b>
                  {repos.problems} of {count(repos.count, "repo", "repos")}
                </b>{" "}
                couldn't be read.
              </>
            ) : !repos.last_read_at ? (
              <>
                <b>{count(repos.count, "repo", "repos")}</b> {repos.count === 1 ? "hasn't" : "haven't"} been read yet.
              </>
            ) : (
              <>
                <span className="dot lead" aria-hidden="true" />
                <b>{count(repos.count, "repo", "repos")}</b> read <Time iso={repos.last_read_at} />, no problems.
              </>
            )
          }
          why="Hive reads each repo's docs and commits so agents can search them."
          action={
            <LinkButton variant="quiet" to="/repos">
              Check sources
            </LinkButton>
          }
        />
      </ul>
    </section>
  );
}

const ALL = { status: "", origin: "", kind: "", q: "", page: 0 };

function Levels({ data, teams, mine }: { data: HomeData; teams: Team[]; mine: MyTeam[] }) {
  const max = Math.max(...data.facts.by_level.map((l) => l.count));
  return (
    <>
      <p className="sub">
        <b>{data.facts.live}</b> live {data.facts.live === 1 ? "fact" : "facts"}, by who gets them
      </p>
      <div className="lvls">
        {data.facts.by_level.map((l) => {
          // The API calls the caller's own personal scope "personal", which levelOfScope can't place.
          const name = levelLabel(l.scope === "personal" ? { scope: l.scope, level: "personal" } : { scope: l.scope }, teams, mine);
          return (
            <Link key={l.scope} className="lvl" to={`/facts${writeFilters({ ...ALL, level: l.scope })}`}>
              <span className="name">
                {name.label} <span className="hint">{name.hint}</span>
              </span>{" "}
              <span className="track" aria-hidden="true">
                <span className="fill" style={{ width: `${(l.count / max) * 100}%` }} />
              </span>{" "}
              <span className="n">{l.count}</span>
            </Link>
          );
        })}
      </div>
    </>
  );
}

function Asides({ data, curator }: { data: HomeData; curator: boolean }) {
  const teams = data.teams.count;
  const month = curator ? data.month : undefined;
  return (
    <div className="asides">
      <div>
        <h2>Teams</h2>
        {teams === 0 ? (
          <>
            <p>No teams yet. A team's agents get its facts before anyone else's, so Billing hears Billing's rules first.</p>
            {curator && (
              <p>
                <LinkButton to="/teams">Create a team</LinkButton>
              </p>
            )}
          </>
        ) : (
          <>
            <p>{count(teams, "team", "teams")}.</p>
            {curator && (
              <p>
                <Link className="more-link" to="/teams">
                  See teams
                </Link>
              </p>
            )}
          </>
        )}
      </div>
      {month && (
        <div>
          <h2>This month</h2>
          <p>
            <b>{dollars(month.cost_usd)}</b> to learn from {count(month.conversations, "conversation", "conversations")}, which proposed{" "}
            {count(month.proposed, "fact", "facts")}. Searching and looking facts up cost nothing.
          </p>
          <p>
            <Link className="more-link" to="/stats">
              See usage and cost
            </Link>
          </p>
        </div>
      )}
    </div>
  );
}

function Recent({ data, teams, mine }: { data: HomeData; teams: Team[]; mine: MyTeam[] }) {
  return (
    <section aria-labelledby="home-recent">
      <div className="h-row">
        <h2 id="home-recent">Recently added</h2>
        <Link className="more-link" to="/facts">
          All {count(data.facts.live, "fact", "facts")}
        </Link>
      </div>
      <div className="home-list">
        {data.recent.map((f) => {
          const t = when(f.recorded_at);
          return (
            <FactRow
              key={f.id}
              href={`/facts/${encodeURIComponent(f.id)}`}
              text={f.text}
              badge={
                <Badge tone="who" title={f.scope}>
                  {levelLabel(f, teams, mine).label}
                </Badge>
              }
              meta={
                <>
                  {word(KIND, f.kind).label},{" "}
                  <time dateTime={f.recorded_at} title={t.title}>
                    {t.text}
                  </time>
                </>
              }
              used={f.use_count !== undefined ? usedTimes(f.use_count) : undefined}
            />
          );
        })}
      </div>
    </section>
  );
}

/** `/`: what needs a curator, what Hive knows, and the newest facts. Read again whenever the tab comes back into view. */
export function Home({ name, role }: { name: string; role: Role }) {
  const curator = role === "curator";
  const [data, setData] = useState<HomeData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { teams, mine } = useTeams();

  const load = useCallback(() => {
    let live = true;
    apiFetch("/v1/home")
      .then(async (res) => {
        if (!res.ok) throw new Error(`The hive answered ${res.status}.`);
        return (await res.json()) as HomeData;
      })
      .then((d) => {
        if (!live) return;
        setData(d);
        setError(null);
      })
      .catch((err: unknown) => live && setError(err instanceof Error ? err.message : "Couldn't load Home."));
    return () => {
      live = false;
    };
  }, []);

  useEffect(() => {
    let stop = load();
    const onVisible = () => {
      if (document.visibilityState !== "visible") return;
      stop();
      stop = load();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      stop();
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [load]);

  const who = name ? `${name[0]!.toUpperCase()}${name.slice(1)}` : "";
  const empty = data?.facts.live === 0;
  return (
    <main className="page home">
      <PageHeader
        title={who ? `${greeting(new Date().getHours())}, ${who}` : greeting(new Date().getHours())}
        lede="Hive is your team's shared memory. Agents are given what's here before they start work."
      />
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {!data && !error && <p className="help">Loading…</p>}
      {data && (
        <>
          {curator && data.waiting !== undefined && <NeedsYou data={data} />}
          <section className="h-split" aria-labelledby="home-knows">
            <div>
              <h2 id="home-knows">What Hive knows</h2>
              {empty ? (
                <EmptyState title="Hive doesn't know anything yet">
                  Hive proposes a fact when someone corrects an agent, and reads each repo's docs. Facts show up here once they're live.
                </EmptyState>
              ) : (
                <Levels data={data} teams={teams} mine={mine} />
              )}
            </div>
            <Asides data={data} curator={curator} />
          </section>
          {!empty && <Recent data={data} teams={teams} mine={mine} />}
        </>
      )}
    </main>
  );
}
