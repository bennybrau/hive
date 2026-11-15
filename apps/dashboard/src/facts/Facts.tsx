import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import { navigate } from "../App";
import { Button, PageHeader } from "../ui";
import { PHRASE } from "../words";
import { AddFact } from "./AddFact";
import { FactDetail } from "./FactDetail";
import { FactsTable } from "./FactsTable";
import { readFilters, writeFilters, type Fact, type Filters } from "./query";
import { useMe } from "./useMe";

function openIdOf(path: string): string | null {
  const m = /^\/facts\/([^/]+)\/?$/.exec(path);
  return m && m[1] !== "new" ? decodeURIComponent(m[1]!) : null;
}

/**
 * /facts?<filters> is the list; /facts/<id>?<filters> also opens that fact in the pane beside it, or as its own page
 * under 1180px. /facts/new?<filters> opens Add a fact there instead.
 */
export function Facts() {
  const [loc, setLoc] = useState(() => ({ path: location.pathname, search: location.search }));
  const listRef = useRef<HTMLDivElement>(null);
  const me = useMe();
  const [reload, setReload] = useState(0);
  const [editing, setEditing] = useState(false);
  // A fact just added stays in the list until the filters change, even where the list wouldn't hold it.
  const [extra, setExtra] = useState<Fact | undefined>(undefined);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    const update = () => setLoc({ path: location.pathname, search: location.search });
    addEventListener("popstate", update);
    return () => removeEventListener("popstate", update);
  }, []);

  const filters = useMemo(() => readFilters(loc.search), [loc.search]);
  const openId = openIdOf(loc.path);
  const adding = /^\/facts\/new\/?$/.test(loc.path);
  const viewing = openId !== null || adding;

  const setFilters = useCallback((f: Filters) => {
    history.replaceState(history.state, "", location.pathname + writeFilters(f));
    setLoc({ path: location.pathname, search: location.search });
    setExtra(undefined);
  }, []);

  // Opening from the list marks the entry, so the back link can return to the list with its place kept.
  const open = useCallback((id: string) => {
    setNotice(null);
    history.pushState({ fromList: true }, "", `/facts/${encodeURIComponent(id)}${location.search}`);
    dispatchEvent(new PopStateEvent("popstate"));
  }, []);

  const startAdding = useCallback(() => {
    history.pushState({ fromList: true }, "", `/facts/new${location.search}`);
    dispatchEvent(new PopStateEvent("popstate"));
  }, []);

  // The added fact opens in place of the form, and shows in the list even if the list wouldn't hold it.
  const added = useCallback((fact: Fact, deduped: boolean) => {
    history.replaceState(history.state, "", `/facts/${encodeURIComponent(fact.id)}${location.search}`);
    setExtra(fact);
    setNotice(deduped ? "That's already a fact." : null);
    setReload((r) => r + 1);
    dispatchEvent(new PopStateEvent("popstate"));
  }, []);

  // A save that replaced the open fact (a new wording, or a merge) opens the new one in place of it, filters kept.
  const replace = useCallback((id: string) => {
    history.replaceState(history.state, "", `/facts/${encodeURIComponent(id)}${location.search}`);
    dispatchEvent(new PopStateEvent("popstate"));
  }, []);
  const saved = useCallback(() => setReload((r) => r + 1), []);

  const close = useCallback(() => {
    setNotice(null);
    navigate(`/facts${location.search}`);
  }, []);

  // Once the fact has closed (Esc, Close, the back link or the browser's Back), focus goes back to its row. Not before:
  // under 1180px the list is hidden while a fact is open, and a hidden row can't take focus.
  const wasOpen = useRef<string | null>(null);
  useEffect(() => {
    if (openId) {
      wasOpen.current = openId;
      return;
    }
    const id = wasOpen.current;
    wasOpen.current = null;
    if (!id) return;
    const rows = [...(listRef.current?.querySelectorAll<HTMLElement>("[data-id]") ?? [])];
    (rows.find((r) => r.dataset.id === id) ?? rows.find((r) => r.tabIndex === 0))?.focus();
  }, [openId]);

  const listHref = `/facts${loc.search}`;
  const back = (e: MouseEvent<HTMLAnchorElement>) => {
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    if ((history.state as { fromList?: boolean } | null)?.fromList) history.back();
    else navigate(listHref);
  };

  useEffect(() => {
    if (!viewing) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !e.defaultPrevented) close();
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [viewing, close]);

  return (
    <main className={viewing ? "page kn view-fact" : "page kn no-fact"}>
      {viewing && (
        <a className="back" href={listHref} onClick={back}>
          <span aria-hidden="true">‹</span>
          {PHRASE.factsBack}
        </a>
      )}
      <PageHeader
        title="Facts"
        lede="Every fact agents are given, and where each one came from."
        action={
          !adding &&
          !editing && (
            <Button variant="primary" onClick={startAdding}>
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M12 5v14M5 12h14" />
              </svg>
              {PHRASE.addFact}
            </Button>
          )
        }
      />
      <div ref={listRef}>
        <FactsTable
          filters={filters}
          onChange={setFilters}
          openId={openId}
          onOpen={open}
          reload={reload}
          extra={extra}
          pane={
            adding ? (
              <AddFact me={me} onAdded={added} onCancel={close} />
            ) : (
              openId && (
                <FactDetail
                  id={openId}
                  me={me}
                  onClose={close}
                  onOpen={(id) => {
                    setNotice(null);
                    navigate(`/facts/${encodeURIComponent(id)}${location.search}`);
                  }}
                  onReplace={replace}
                  onSaved={saved}
                  onEditing={setEditing}
                  notice={notice}
                />
              )
            )
          }
        />
      </div>
    </main>
  );
}
