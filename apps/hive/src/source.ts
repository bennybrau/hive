export interface SourceColumns {
  ep_kind: string | null;
  ep_ref: string | null;
  ep_user_id: string | null;
  ep_author: string | null;
  ep_at: Date | null;
}

/** Not people: the factory's own user id, and the name the factory records for a message sent through its API
 *  without one. Never shown as who said something. */
export const NOT_A_PERSON = new Set(["asf-factory", "operator"]);

/** Where an anchor's episode came from, in words the dashboard maps to a label; null without an episode. */
export function sourceOf(row: SourceColumns): { kind: string; author: string | null; where: string; at: string } | null {
  if (row.ep_kind === null || row.ep_at === null) return null;
  const author = row.ep_author ?? row.ep_user_id ?? null;
  const ref = row.ep_ref ?? "";
  const where =
    row.ep_kind === "asf_dialog" && ref.includes(":gate:") ? "factory_plan_note"
    : row.ep_kind === "asf_dialog" && ref.includes(":msg:") ? "factory_chat"
    : row.ep_kind === "asf_run" ? "factory_run"
    : row.ep_kind === "turn" || row.ep_kind === "session" ? "conversation"
    : row.ep_kind === "commit" ? "commit"
    : "other";
  return { kind: row.ep_kind, author: author !== null && NOT_A_PERSON.has(author) ? null : author, where, at: row.ep_at.toISOString() };
}
