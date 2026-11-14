import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { navigate } from "../App";
import { PageHeader } from "../ui";
import { FactDetail } from "./FactDetail";
import { FactsTable } from "./FactsTable";
import { readFilters, writeFilters, type Filters } from "./query";

function openIdOf(path: string): string | null {
  const m = /^\/facts\/([^/]+)\/?$/.exec(path);
  return m ? decodeURIComponent(m[1]!) : null;
}

/** /facts?<filters> is the table; /facts/<id>?<filters> also opens that fact beside it. */
export function Facts() {
  const [loc, setLoc] = useState(() => ({ path: location.pathname, search: location.search }));
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const update = () => setLoc({ path: location.pathname, search: location.search });
    addEventListener("popstate", update);
    return () => removeEventListener("popstate", update);
  }, []);

  const filters = useMemo(() => readFilters(loc.search), [loc.search]);
  const openId = openIdOf(loc.path);

  const setFilters = useCallback((f: Filters) => {
    history.replaceState(null, "", location.pathname + writeFilters(f));
    setLoc({ path: location.pathname, search: location.search });
  }, []);

  const open = useCallback((id: string) => navigate(`/facts/${encodeURIComponent(id)}${location.search}`), []);

  const close = useCallback(() => {
    navigate(`/facts${location.search}`);
    const rows = [...(listRef.current?.querySelectorAll<HTMLElement>("[data-id]") ?? [])];
    (rows.find((r) => r.dataset.id === openId) ?? rows.find((r) => r.tabIndex === 0))?.focus();
  }, [openId]);

  useEffect(() => {
    if (!openId) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !e.defaultPrevented) close();
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [openId, close]);

  return (
    <main className={openId ? "page facts-page open" : "page facts-page"}>
      <div ref={listRef}>
        <PageHeader title="Facts" lede="Every fact agents are given, and where each one came from." />
        <FactsTable filters={filters} onChange={setFilters} openId={openId} onOpen={open} />
      </div>
      {openId && <FactDetail id={openId} onClose={close} onOpen={open} />}
    </main>
  );
}
