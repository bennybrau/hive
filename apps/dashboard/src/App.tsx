import { useEffect, useState } from "react";
import { apiFetch, getToken, onSignOut, type Status } from "./api";
import { Facts } from "./facts/Facts";
import { Home } from "./home/Home";
import { Playbooks } from "./playbooks/Playbooks";
import { Repos } from "./repos/Repos";
import { Review } from "./review/Review";
import { Search } from "./search/Search";
import { Settings } from "./settings/Settings";
import { Shell } from "./Shell";
import { Stale } from "./stale/Stale";
import { Stats } from "./stats/Stats";
import { Teams } from "./teams/Teams";
import { Tokens } from "./tokens/Tokens";
import { SignIn } from "./SignIn";
import { Link, PageHeader } from "./ui";

export function navigate(path: string): void {
  history.pushState(null, "", path);
  dispatchEvent(new PopStateEvent("popstate"));
}

function usePath(): string {
  const [path, setPath] = useState(location.pathname);
  useEffect(() => {
    const update = () => setPath(location.pathname);
    addEventListener("popstate", update);
    return () => removeEventListener("popstate", update);
  }, []);
  return path;
}

export function App() {
  const path = usePath();
  // null = signed out; "loading" = checking a token left in this tab.
  const [status, setStatus] = useState<Status | "loading" | null>(() => (getToken() ? "loading" : null));

  useEffect(() => onSignOut(() => setStatus(null)), []);

  useEffect(() => {
    if (status !== "loading") return;
    let live = true;
    apiFetch("/v1/status")
      .then((res) => (res.ok ? (res.json() as Promise<Status>) : null))
      .then((s) => live && setStatus(s))
      .catch(() => live && setStatus(null));
    return () => {
      live = false;
    };
  }, [status]);

  if (status === "loading") return null;
  if (!status) return <SignIn onSignedIn={setStatus} />;
  return (
    <Shell status={status} path={path}>
      {path === "/" ? (
        <Home name={status.instance.user_id || status.instance.name} role={status.instance.role} />
      ) : path === "/facts" || path.startsWith("/facts/") ? (
        <Facts />
      ) : path === "/review" ? (
        <Review role={status.instance.role} />
      ) : path === "/stale" ? (
        <Stale role={status.instance.role} />
      ) : path === "/search" ? (
        <Search />
      ) : path === "/stats" ? (
        <Stats role={status.instance.role} />
      ) : path === "/settings" ? (
        <Settings role={status.instance.role} />
      ) : path === "/teams" ? (
        <Teams role={status.instance.role} />
      ) : path === "/tokens" ? (
        <Tokens role={status.instance.role} selfId={status.instance.id} />
      ) : path === "/repos" ? (
        <Repos role={status.instance.role} />
      ) : path === "/playbooks" || path.startsWith("/playbooks/") ? (
        <Playbooks role={status.instance.role} path={path} />
      ) : (
        <main className="page">
          <PageHeader
            title="Not found"
            lede={
              <>
                There's no page at <code>{path}</code>. <Link to="/facts">Go to Facts</Link>
              </>
            }
          />
        </main>
      )}
    </Shell>
  );
}
