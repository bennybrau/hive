import { useCallback, useEffect, useRef, useState } from "react";
import { apiFetch } from "../api";

export const UNDO_MS = 5000;

export interface Decision {
  id: string;
  action: "approve" | "fix" | "reject";
  note?: string;
  new_text?: string;
}

/**
 * Holds one review decision back for UNDO_MS so it can be undone. The decided row is hidden at once; the POST goes
 * out when the timer ends, when the next decision is made, on unmount, or on pagehide. A non-2xx brings the row back.
 */
export function usePendingDecision() {
  const [hidden, setHidden] = useState<ReadonlySet<string>>(() => new Set());
  const [pending, setPending] = useState<Decision | null>(null);
  const [error, setError] = useState<string | null>(null);
  const pendingRef = useRef<Decision | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const mounted = useRef(true);

  const show = useCallback((id: string) => {
    setHidden((h) => {
      const next = new Set(h);
      next.delete(id);
      return next;
    });
  }, []);

  const commit = useCallback(
    (keepalive = false) => {
      const d = pendingRef.current;
      if (!d) return;
      pendingRef.current = null;
      clearTimeout(timer.current);
      if (mounted.current) setPending(null);
      const { id, ...body } = d;
      const fail = (why: string) => {
        if (!mounted.current) return;
        show(id);
        setError(`Couldn't save that decision: ${why}`);
      };
      apiFetch(`/v1/facts/${encodeURIComponent(id)}/review`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        keepalive,
      })
        .then(async (res) => {
          if (res.ok) return;
          const msg = await res
            .json()
            .then((b: { error?: string }) => b.error)
            .catch(() => undefined);
          fail(msg ? `${msg} (${res.status}).` : `the hive answered ${res.status}.`);
        })
        .catch(() => fail("the hive didn't answer."));
    },
    [show],
  );

  const decide = useCallback(
    (d: Decision) => {
      commit();
      setError(null);
      pendingRef.current = d;
      setPending(d);
      setHidden((h) => new Set(h).add(d.id));
      timer.current = setTimeout(() => commit(), UNDO_MS);
    },
    [commit],
  );

  const undo = useCallback(() => {
    const d = pendingRef.current;
    if (!d) return;
    pendingRef.current = null;
    clearTimeout(timer.current);
    setPending(null);
    show(d.id);
  }, [show]);

  useEffect(() => {
    mounted.current = true;
    const onHide = () => commit(true);
    addEventListener("pagehide", onHide);
    return () => {
      removeEventListener("pagehide", onHide);
      mounted.current = false;
      commit(true);
    };
  }, [commit]);

  return { hidden, pending, error, decide, undo };
}
