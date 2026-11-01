import type { ReactNode } from "react";
import { signOut, type Status } from "./api";

export function Shell({ status, children }: { status: Status; children: ReactNode }) {
  return (
    <>
      <header className="shell">
        <span className="brand">hive</span>
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
