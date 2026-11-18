import { useEffect, useState, type ReactNode } from "react";
import { apiFetch, signOut, type Status } from "./api";
import { Button, Link, Tabs, isCurrent, type Tab } from "./ui";

const ICONS = {
  home: (
    <>
      <path d="M3 11l9-7 9 7" />
      <path d="M5 10v10h14V10" />
    </>
  ),
  knowledge: <path d="M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM20 20l-4-4" />,
  review: (
    <>
      <path d="M4 5h16v11H8l-4 4z" />
      <path d="M9 10l2 2 4-4" />
    </>
  ),
  playbooks: (
    <>
      <path d="M5 4h11l3 3v13H5z" />
      <path d="M9 10h6M9 14h6M9 18h3" />
    </>
  ),
  teams: (
    <>
      <circle cx="9" cy="8" r="3" />
      <path d="M3 20c0-3.3 2.7-6 6-6s6 2.7 6 6" />
      <circle cx="17" cy="9" r="2.5" />
      <path d="M16 14c2.8 0 5 2.2 5 5" />
    </>
  ),
  admin: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9L7 7M17 17l2.1 2.1M4.9 19.1L7 17M17 7l2.1-2.1" />
    </>
  ),
};

const MARK = (
  <span className="mark" aria-hidden="true">
    <svg viewBox="0 0 24 24">
      <path d="M12 3l7.8 4.5v9L12 21l-7.8-4.5v-9z" />
      <path d="M12 8l3.5 2v4L12 16l-3.5-2v-4z" />
    </svg>
  </span>
);

const isFacts = (p: string) => p === "/facts" || p.startsWith("/facts/");

interface Section {
  key: keyof typeof ICONS;
  label: string;
  curatorOnly: boolean;
  /** Section tabs; the first is where the menu item goes. `curatorOnly` tabs are hidden from members. */
  tabs: (Tab & { curatorOnly?: boolean })[];
}

/**
 * The menu. Each item is a section; a section with more than one page shows them as tabs above the page.
 * The page addresses are unchanged for now (the manual and the review digest link to them); each page
 * moves to its new address when it is rebuilt.
 */
export const SECTIONS: Section[] = [
  { key: "home", label: "Home", curatorOnly: false, tabs: [{ to: "/", label: "Home", match: (p) => p === "/" }] },
  {
    key: "knowledge",
    label: "Knowledge",
    curatorOnly: false,
    tabs: [
      { to: "/facts", label: "Facts", match: isFacts },
      { to: "/search", label: "Search" },
    ],
  },
  {
    key: "review",
    label: "Review",
    curatorOnly: true,
    tabs: [
      { to: "/review", label: "New" },
      { to: "/stale", label: "Out of date" },
    ],
  },
  { key: "playbooks", label: "Playbooks", curatorOnly: true, tabs: [{ to: "/playbooks", label: "Playbooks", match: (p) => p === "/playbooks" || p.startsWith("/playbooks/") }] },
  { key: "teams", label: "Teams", curatorOnly: true, tabs: [{ to: "/teams", label: "Teams" }] },
  {
    key: "admin",
    label: "Admin",
    curatorOnly: false,
    tabs: [
      { to: "/repos", label: "Sources" },
      { to: "/stats", label: "Usage and cost", curatorOnly: true },
      { to: "/settings", label: "Notifications", curatorOnly: true },
      { to: "/tokens", label: "Tokens", curatorOnly: true },
    ],
  },
];

const ROLE_LABEL: Record<string, string> = { curator: "Curator", member: "Member", worker: "Worker" };

function sectionsFor(role: string) {
  const curator = role === "curator";
  return SECTIONS.filter((s) => curator || !s.curatorOnly).map((s) => ({ ...s, tabs: s.tabs.filter((t) => curator || !t.curatorOnly) }));
}

/** How many facts wait for review (curators only); refreshed whenever the page changes. */
function useWaiting(curator: boolean, path: string): number | null {
  const [n, setN] = useState<number | null>(null);
  useEffect(() => {
    if (!curator) return;
    let live = true;
    apiFetch("/v1/stats?days=1")
      .then((r) => (r.ok ? (r.json() as Promise<{ backlog?: { candidates?: number } }>) : null))
      .then((s) => {
        const c = s?.backlog?.candidates;
        if (live) setN(typeof c === "number" ? c : null);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [curator, path]);
  return n;
}

export function Shell({ status, path, children }: { status: Status; path: string; children: ReactNode }) {
  const role = status.instance.role;
  const sections = sectionsFor(role);
  const here = sections.find((s) => s.tabs.some((t) => isCurrent(t, path)));
  const waiting = useWaiting(role === "curator", path);
  const [menuOpen, setMenuOpen] = useState(false);
  useEffect(() => setMenuOpen(false), [path]);

  const item = (s: (typeof sections)[number]) => (
    <Link key={s.key} to={s.tabs[0]!.to} aria-current={s === here ? "page" : undefined}>
      <svg viewBox="0 0 24 24" aria-hidden="true">
        {ICONS[s.key]}
      </svg>
      {s.label}
      {s.key === "review" && waiting ? (
        <span className="count" aria-label={`${waiting} waiting`}>
          {waiting}
        </span>
      ) : null}
    </Link>
  );
  const everyone = sections.filter((s) => !s.curatorOnly && s.key !== "admin");
  const curatorOnly = sections.filter((s) => s.curatorOnly);
  const admin = sections.find((s) => s.key === "admin");
  const name = status.instance.user_id || status.instance.name;

  return (
    <div className={menuOpen ? "app menu-open" : "app"}>
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <header className="topbar">
        {MARK}
        <span className="where">{here?.label ?? "Hive"}</span>
        <Button variant="quiet" aria-expanded={menuOpen} aria-controls="sidebar" onClick={() => setMenuOpen((o) => !o)}>
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d={menuOpen ? "M6 6l12 12M18 6L6 18" : "M4 7h16M4 12h16M4 17h16"} />
          </svg>
          {menuOpen ? "Close" : "Menu"}
        </Button>
      </header>
      <aside className="side" id="sidebar">
        <div className="brand">
          {MARK}
          Hive
        </div>
        <nav aria-label="Main">
          {everyone.map(item)}
          {curatorOnly.length > 0 && <div className="group">Curator</div>}
          {curatorOnly.map(item)}
          {admin && item(admin)}
        </nav>
        <details className="account">
          <summary>
            <span className="avatar" aria-hidden="true">
              {name.slice(0, 1)}
            </span>
            <span className="who">
              <b>{name}</b>
              <span aria-label="role">{ROLE_LABEL[role] ?? role}</span>
            </span>
          </summary>
          <div className="panel">
            <span>
              Signed in with the token <b>{status.instance.name}</b>, kept for this tab only.
            </span>
            <Button onClick={signOut}>Sign out</Button>
          </div>
        </details>
      </aside>
      <div className="content" id="main" tabIndex={-1}>
        {here && here.tabs.length > 1 && <Tabs tabs={here.tabs} path={path} label={`${here.label} pages`} className="section-tabs" />}
        {children}
      </div>
    </div>
  );
}
