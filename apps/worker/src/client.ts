import type { DistilledFact } from "./prompt.js";
import type { Usage } from "./runners/types.js";

export interface Claimed {
  job: { id: string; attempts: number; lease_until: string };
  episode: {
    id: string;
    kind: string;
    repo_key: string | null;
    content: string;
    /** A turn the user flagged: distill what they asked to remember. */
    remember_request: boolean;
    /** `personal:<user>` on a remember job, else null. */
    personal_scope: string | null;
  };
  prompt_version: string;
  credential: string;
}

export type ClaimResult = { kind: "job"; claim: Claimed } | { kind: "none" } | { kind: "unavailable"; error: string };

/** 409 = someone else holds the job now (our lease ran out): nothing to do. */
export type Outcome = "ok" | "conflict";

/** The hive's /v1/worker/distill endpoints. */
export class HiveClient {
  constructor(
    private baseUrl: string,
    private token: string,
    private fetchFn: typeof fetch = fetch,
  ) {}

  private post(path: string, body?: unknown): Promise<Response> {
    const headers: Record<string, string> = { authorization: `Bearer ${this.token}` };
    if (body !== undefined) headers["content-type"] = "application/json";
    return this.fetchFn(`${this.baseUrl.replace(/\/$/, "")}${path}`, {
      method: "POST",
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }

  /** Long-polls: 204 after the hive's wait with nothing queued; 503 while no agent credential is set. */
  async claim(): Promise<ClaimResult> {
    const res = await this.post("/v1/worker/distill/claim");
    if (res.status === 204) return { kind: "none" };
    if (res.status === 503) return { kind: "unavailable", error: await errorOf(res) };
    if (!res.ok) throw new Error(`claim: ${res.status} ${await errorOf(res)}`);
    return { kind: "job", claim: (await res.json()) as Claimed };
  }

  complete(id: string, body: { facts: DistilledFact[]; usage: Usage }): Promise<Outcome> {
    return this.finish("complete", id, body);
  }

  fail(id: string, error: string): Promise<Outcome> {
    return this.finish("fail", id, { error: error.slice(0, 4000) || "unknown error" });
  }

  private async finish(action: "complete" | "fail", id: string, body: unknown): Promise<Outcome> {
    const res = await this.post(`/v1/worker/distill/${encodeURIComponent(id)}/${action}`, body);
    if (res.status === 409) return "conflict";
    if (!res.ok) throw new Error(`${action}: ${res.status} ${await errorOf(res)}`);
    return "ok";
  }
}

async function errorOf(res: Response): Promise<string> {
  const text = await res.text().catch(() => "");
  try {
    return String((JSON.parse(text) as { error?: unknown }).error ?? text).slice(0, 500);
  } catch {
    return text.slice(0, 500);
  }
}
