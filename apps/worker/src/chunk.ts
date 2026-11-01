/** ~12k tokens at ~4 chars per token. */
export const MAX_CHUNK_CHARS = 12_000 * 4;

/** Split a transcript into turns. A turn starts at a line beginning `user: ` (the plugin's transcript format). */
export function splitTurns(text: string): string[] {
  const turns: string[][] = [];
  for (const line of text.split("\n")) {
    if (line.startsWith("user: ") || !turns.length) turns.push([line]);
    else turns[turns.length - 1]!.push(line);
  }
  return turns.map((t) => t.join("\n")).filter((t) => t.trim());
}

/**
 * Chunks of at most `max` chars, cut between turns. Each chunk after the first starts with the last turn of
 * the one before, so a decision and the turn that prompted it are seen together. A turn longer than `max`
 * is hard-cut into `max`-sized pieces.
 */
export function chunkTranscript(text: string, max = MAX_CHUNK_CHARS): string[] {
  const pieces: string[] = [];
  for (const turn of splitTurns(text)) {
    for (let i = 0; i < turn.length; i += max) pieces.push(turn.slice(i, i + max));
  }
  const chunks: string[] = [];
  let cur: string[] = [];
  let len = 0;
  for (const piece of pieces) {
    if (cur.length && len + 1 + piece.length > max) {
      chunks.push(cur.join("\n"));
      const prev = cur[cur.length - 1]!;
      cur = prev.length + 1 + piece.length <= max ? [prev] : [];
      len = cur.length ? prev.length : 0;
    }
    len += (cur.length ? 1 : 0) + piece.length;
    cur.push(piece);
  }
  if (cur.length) chunks.push(cur.join("\n"));
  return chunks;
}
