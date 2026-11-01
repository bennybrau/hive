const TOKEN_KEY = "hive.token";

export type Role = "member" | "curator" | "worker";

export interface Status {
  version: string;
  instance: { id: string; name: string; user_id: string; role: Role };
}

export function getToken(): string | null {
  return sessionStorage.getItem(TOKEN_KEY);
}

export function setToken(token: string): void {
  sessionStorage.setItem(TOKEN_KEY, token);
}

const signOutListeners = new Set<() => void>();

/** Called whenever the token is dropped (sign out, or the hive answered 401). Returns an unsubscribe. */
export function onSignOut(fn: () => void): () => void {
  signOutListeners.add(fn);
  return () => signOutListeners.delete(fn);
}

export function signOut(): void {
  sessionStorage.removeItem(TOKEN_KEY);
  for (const fn of signOutListeners) fn();
}

export class ApiError extends Error {
  constructor(readonly status: number) {
    super(`hive answered ${status}`);
  }
}

/** fetch with the stored bearer token; a 401 signs out so the app returns to SignIn. */
export async function apiFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  const token = getToken();
  if (token) headers.set("authorization", `Bearer ${token}`);
  const res = await fetch(path, { ...init, headers });
  if (res.status === 401) {
    signOut();
    throw new ApiError(401);
  }
  return res;
}

/** GET /v1/status with a token that isn't stored yet; resolves only on a 200. */
export async function checkToken(token: string): Promise<Status> {
  const res = await fetch("/v1/status", { headers: { authorization: `Bearer ${token}` } });
  if (!res.ok) throw new ApiError(res.status);
  return (await res.json()) as Status;
}
