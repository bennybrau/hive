import type { ReactNode } from "react";
import { navigate } from "./App";
import { signOut, type Status } from "./api";

function NavLink({ to, path, children }: { to: string; path: string; children: ReactNode }) {
  const here = path === to || path.startsWith(`${to}/`);
  return (
    <a
      href={to}
      aria-current={here ? "page" : undefined}
      onClick={(e) => {
        e.preventDefault();
        navigate(to);
      }}
    >
      {children}
    </a>
  );
}

export function Shell({ status, path, children }: { status: Status; path: string; children: ReactNode }) {
  return (
    <>
      <header className="shell">
        <span className="brand">hive</span>
        <nav aria-label="Main">
          <NavLink to="/facts" path={path}>
            Facts
          </NavLink>
          <NavLink to="/search" path={path}>
            Search
          </NavLink>
          <NavLink to="/repos" path={path}>
            Repos
          </NavLink>
          {status.instance.role === "curator" && (
            <>
              <NavLink to="/review" path={path}>
                Review
              </NavLink>
              <NavLink to="/playbooks" path={path}>
                Playbooks
              </NavLink>
              <NavLink to="/stale" path={path}>
                Stale
              </NavLink>
              <NavLink to="/teams" path={path}>
                Teams
              </NavLink>
              <NavLink to="/stats" path={path}>
                Stats
              </NavLink>
              <NavLink to="/settings" path={path}>
                Settings
              </NavLink>
            </>
          )}
        </nav>
        <span className="instance">{status.instance.name}</span>
        <span className="role" aria-label="role">
          {status.instance.role}
        </span>
        <button type="button" onClick={signOut}>
          Sign out
        </button>
      </header>
      {children}
    </>
  );
}
