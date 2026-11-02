import { useEffect, useState } from "react";
import { apiFetch, getToken, onSignOut, type Status } from "./api";
import { Facts } from "./facts/Facts";
import { Repos } from "./repos/Repos";
import { Review } from "./review/Review";
import { Search } from "./search/Search";
import { Shell } from "./Shell";
import { Stats } from "./stats/Stats";
import { SignIn } from "./SignIn";

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

  useEffect(() => {
    if (path === "/") navigate("/facts");
  }, [path]);

  if (status === "loading") return null;
  if (!status) return <SignIn onSignedIn={setStatus} />;
  return (
    <Shell status={status} path={path}>
      {path === "/facts" || path.startsWith("/facts/") ? (
        <Facts />
      ) : path === "/review" ? (
        <Review role={status.instance.role} />
      ) : path === "/search" ? (
        <Search />
      ) : path === "/stats" ? (
        <Stats role={status.instance.role} />
      ) : path === "/repos" ? (
        <Repos role={status.instance.role} />
      ) : (
        <main className="page">
          <h1>Not found</h1>
          <p className="help">
            Nothing lives at <code>{path}</code>.{" "}
            <a
              href="/facts"
              onClick={(e) => {
                e.preventDefault();
                navigate("/facts");
              }}
            >
              Go to Facts
            </a>
          </p>
        </main>
      )}
    </Shell>
  );
}
