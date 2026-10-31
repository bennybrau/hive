/**
 * Split extracted text into search-sized chunks that remember their line range.
 * Breaks on paragraph boundaries (blank lines); a markdown heading starts a new chunk once the
 * current one has some substance, so a chunk tends to be one section. Oversized paragraphs are
 * split by lines. Embedding model context is 8K tokens; ~1500 chars keeps each chunk focused.
 */
export interface Chunk {
  index: number;
  content: string;
  lineStart: number; // 1-based, inclusive
  lineEnd: number;
}

export const TARGET_CHARS = 1500;
const MIN_BEFORE_HEADING = 300;

interface Block {
  text: string;
  start: number;
  end: number;
  heading: boolean;
}

const isHeading = (line: string) => /^\s{0,3}#{1,6}\s/.test(line);

function blocks(text: string): Block[] {
  const lines = text.split("\n");
  const out: Block[] = [];
  let cur: string[] = [];
  let start = -1; // 0-based index of cur[0]
  const flush = (endLine: number) => {
    // endLine: 1-based number of the last line in cur (= 0-based index of the line after it)
    if (cur.length) out.push({ text: cur.join("\n").trimEnd(), start: start + 1, end: endLine, heading: isHeading(cur[0]!) });
    cur = [];
    start = -1;
  };
  lines.forEach((line, i) => {
    if (!line.trim()) return flush(i);
    if (isHeading(line) && cur.length) flush(i);
    if (start < 0) start = i;
    cur.push(line);
  });
  flush(lines.length);
  // split any block bigger than the target by lines
  return out.flatMap((b) => {
    if (b.text.length <= TARGET_CHARS) return [b];
    const parts: Block[] = [];
    const ls = b.text.split("\n");
    let acc: string[] = [];
    let s = b.start;
    ls.forEach((l, i) => {
      if (acc.length && acc.join("\n").length + l.length > TARGET_CHARS) {
        parts.push({ text: acc.join("\n"), start: s, end: b.start + i - 1, heading: parts.length === 0 && b.heading });
        acc = [];
        s = b.start + i;
      }
      // a single enormous line (minified, CSV-ish) is cut hard
      for (let off = 0; off < l.length; off += TARGET_CHARS * 2) acc.push(l.slice(off, off + TARGET_CHARS * 2));
    });
    if (acc.length) parts.push({ text: acc.join("\n"), start: s, end: b.end, heading: parts.length === 0 && b.heading });
    return parts;
  });
}

export function chunkText(text: string): Chunk[] {
  const chunks: Chunk[] = [];
  let acc: Block[] = [];
  const size = () => acc.reduce((n, b) => n + b.text.length + 2, 0);
  const flush = () => {
    if (!acc.length) return;
    chunks.push({
      index: chunks.length,
      content: acc.map((b) => b.text).join("\n\n"),
      lineStart: acc[0]!.start,
      lineEnd: acc[acc.length - 1]!.end,
    });
    acc = [];
  };
  for (const b of blocks(text)) {
    if (acc.length && (size() + b.text.length > TARGET_CHARS || (b.heading && size() >= MIN_BEFORE_HEADING))) flush();
    acc.push(b);
  }
  flush();
  return chunks;
}
