import { useEffect, useState } from "react";
import { apiFetch, type Role, type Status } from "../api";

export interface Me {
  role: Role;
  user_id: string;
}

/** Who is signed in, from GET /v1/status; null until it answers (or if it fails). */
export function useMe(): Me | null {
  const [me, setMe] = useState<Me | null>(null);
  useEffect(() => {
    let live = true;
    apiFetch("/v1/status")
      .then(async (res) => {
        if (!res.ok) throw new Error(`The hive answered ${res.status}.`);
        return (await res.json()) as Status;
      })
      .then((s) => live && setMe({ role: s.instance.role, user_id: s.instance.user_id }))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);
  return me;
}
