import { apiFetch } from "../api";

export interface PlaybookItem {
  text: string;
  fact_ids: string[];
}

export interface Playbook {
  id: string;
  scope: string;
  title: string;
  applies_paths: string[];
  applies_words: string[];
  steps: PlaybookItem[];
  pitfalls: PlaybookItem[];
  status: "active" | "superseded" | "retracted";
  supersedes: string | null;
  author_user_id: string | null;
  created_at: string;
}

/** What create and update send. */
export interface PlaybookInput {
  scope: string;
  title: string;
  applies_paths: string[];
  applies_words: string[];
  steps: PlaybookItem[];
  pitfalls: PlaybookItem[];
}

/** Any answer that isn't 2xx, carrying the hive's `{error}` text. */
export class PlaybookApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await apiFetch(path, init);
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new PlaybookApiError(res.status, body?.error ?? `The hive answered ${res.status}.`);
  }
  return (await res.json()) as T;
}

const send = (method: string, body: PlaybookInput): RequestInit => ({
  method,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

/** Active playbooks, newest first. */
export async function listPlaybooks(scope?: string): Promise<Playbook[]> {
  const q = scope ? `?scope=${encodeURIComponent(scope)}` : "";
  return (await call<{ playbooks: Playbook[] }>(`/v1/playbooks${q}`)).playbooks;
}

export async function getPlaybook(id: string): Promise<Playbook> {
  return (await call<{ playbook: Playbook }>(`/v1/playbooks/${encodeURIComponent(id)}`)).playbook;
}

export async function createPlaybook(input: PlaybookInput): Promise<Playbook> {
  return (await call<{ playbook: Playbook }>("/v1/playbooks", send("POST", input))).playbook;
}

/** Inserts a new active version that supersedes `id`; returns it. */
export async function updatePlaybook(id: string, input: PlaybookInput): Promise<Playbook> {
  return (await call<{ playbook: Playbook }>(`/v1/playbooks/${encodeURIComponent(id)}`, send("PUT", input))).playbook;
}

export async function retractPlaybook(id: string): Promise<Playbook> {
  return (await call<{ playbook: Playbook }>(`/v1/playbooks/${encodeURIComponent(id)}`, { method: "DELETE" })).playbook;
}
