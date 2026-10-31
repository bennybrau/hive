/**
 * Turn a document into plain text for search and verify.
 *   .md/.mdx/.markdown/.txt/.rst  as-is
 *   .pdf                          `pdftotext` (poppler); no text layer (a scan) -> empty, indexed as nothing
 *   .docx/.pptx/.xlsx             unzip + read the XML text runs (fflate; no Office, no network)
 * Line numbers in the result match the source for text formats; for the others they are lines of
 * the extracted text (what search shows), which is the best we can do without a renderer.
 */
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { strFromU8, unzipSync } from "fflate";

const run = promisify(execFile);

export const TEXT_EXTS = new Set([".md", ".mdx", ".markdown", ".txt", ".rst"]);
export const BINARY_EXTS = new Set([".pdf", ".docx", ".pptx", ".xlsx"]);
export const MAX_DOC_BYTES = 25 * 1024 * 1024;
export const MAX_TEXT_CHARS = 2_000_000;

export type DocKind = "text" | "pdf" | "docx" | "pptx" | "xlsx";

export function docKind(file: string): DocKind | null {
  const ext = path.extname(file).toLowerCase();
  if (TEXT_EXTS.has(ext)) return "text";
  if (BINARY_EXTS.has(ext)) return ext.slice(1) as DocKind;
  return null;
}

export class ExtractError extends Error {}

export async function extractText(file: string, bytes: Buffer): Promise<string> {
  const kind = docKind(file);
  let text: string;
  switch (kind) {
    case "text":
      text = bytes.toString("utf8");
      break;
    case "pdf":
      text = await pdfText(bytes);
      break;
    case "docx":
      text = docxText(unzip(bytes));
      break;
    case "pptx":
      text = pptxText(unzip(bytes));
      break;
    case "xlsx":
      text = xlsxText(unzip(bytes));
      break;
    default:
      throw new ExtractError(`not a document type we read: ${file}`);
  }
  return text.replace(/\r\n?/g, "\n").replace(/\u0000/g, "").slice(0, MAX_TEXT_CHARS);
}

async function pdfText(bytes: Buffer): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "hive-pdf-"));
  try {
    const file = path.join(dir, "in.pdf");
    await writeFile(file, bytes);
    const { stdout } = await run("pdftotext", ["-q", "-enc", "UTF-8", file, "-"], { maxBuffer: 64 * 1024 * 1024 });
    return stdout.replace(/\f/g, "\n");
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === "ENOENT") throw new ExtractError("pdftotext not installed (poppler-utils)");
    throw new ExtractError(`pdftotext failed: ${e.message.split("\n")[0]}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function unzip(bytes: Buffer): Record<string, Uint8Array> {
  try {
    // Only the XML parts we read; skips media, which is most of a deck's size.
    return unzipSync(new Uint8Array(bytes), { filter: (f) => f.name.endsWith(".xml") });
  } catch {
    throw new ExtractError("not a valid Office file (zip)");
  }
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
export function decodeXml(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const code = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e] ?? m;
  });
}

/** Paragraphs of an OOXML part: text runs (`<w:t>` / `<a:t>`) joined per paragraph (`<w:p>` / `<a:p>`). */
function paragraphs(xml: string, ns: "w" | "a"): string[] {
  const out: string[] = [];
  const paraRe = new RegExp(`<${ns}:p[ >][\\s\\S]*?</${ns}:p>|<${ns}:p/>`, "g");
  const runRe = new RegExp(`<${ns}:t(?: [^>]*)?>([\\s\\S]*?)</${ns}:t>|<${ns}:tab/>|<${ns}:br/>`, "g");
  for (const p of xml.match(paraRe) ?? []) {
    let line = "";
    for (const m of p.matchAll(runRe)) {
      if (m[1] !== undefined) line += decodeXml(m[1]);
      else line += m[0].includes("tab") ? "\t" : "\n";
    }
    out.push(line);
  }
  return out;
}

function part(files: Record<string, Uint8Array>, name: string): string | null {
  const f = files[name];
  return f ? strFromU8(f) : null;
}

function docxText(files: Record<string, Uint8Array>): string {
  const doc = part(files, "word/document.xml");
  if (doc === null) throw new ExtractError("not a Word document (no word/document.xml)");
  return paragraphs(doc, "w").join("\n");
}

const numbered = (files: Record<string, Uint8Array>, re: RegExp) =>
  Object.keys(files)
    .map((name) => ({ name, n: Number(re.exec(name)?.[1]) }))
    .filter((x) => Number.isFinite(x.n) && x.n > 0)
    .sort((a, b) => a.n - b.n);

function pptxText(files: Record<string, Uint8Array>): string {
  const slides = numbered(files, /^ppt\/slides\/slide(\d+)\.xml$/);
  if (!slides.length && !files["ppt/presentation.xml"]) throw new ExtractError("not a PowerPoint deck");
  return slides
    .map(({ name, n }) => {
      const body = paragraphs(strFromU8(files[name]!), "a").filter((l) => l.trim());
      const notes = part(files, `ppt/notesSlides/notesSlide${n}.xml`);
      const noteLines = notes ? paragraphs(notes, "a").filter((l) => l.trim() && !/^\d+$/.test(l.trim())) : [];
      return [`## Slide ${n}`, ...body, ...(noteLines.length ? ["Notes:", ...noteLines] : [])].join("\n");
    })
    .join("\n\n");
}

function colIndex(ref: string): number {
  const letters = /^[A-Z]+/.exec(ref)?.[0] ?? "A";
  let n = 0;
  for (const c of letters) n = n * 26 + (c.charCodeAt(0) - 64);
  return n - 1;
}

function xlsxText(files: Record<string, Uint8Array>): string {
  const wb = part(files, "xl/workbook.xml");
  if (wb === null) throw new ExtractError("not an Excel workbook");
  const shared: string[] = [];
  const ss = part(files, "xl/sharedStrings.xml");
  if (ss) {
    for (const si of ss.match(/<si>[\s\S]*?<\/si>/g) ?? []) {
      shared.push([...si.matchAll(/<t(?: [^>]*)?>([\s\S]*?)<\/t>/g)].map((m) => decodeXml(m[1]!)).join(""));
    }
  }
  // sheet names in workbook order; sheetN.xml files are in the same order for files Excel/LibreOffice write
  const names = [...wb.matchAll(/<sheet [^>]*name="([^"]*)"/g)].map((m) => decodeXml(m[1]!));
  const sheets = numbered(files, /^xl\/worksheets\/sheet(\d+)\.xml$/);
  return sheets
    .map(({ name, n }, i) => {
      const xml = strFromU8(files[name]!);
      const rows: string[] = [];
      for (const row of xml.match(/<row[ >][\s\S]*?<\/row>/g) ?? []) {
        const cells: string[] = [];
        for (const c of row.matchAll(/<c ([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
          const attrs = c[1]!;
          const inner = c[2] ?? "";
          const ref = /r="([A-Z]+)\d+"/.exec(attrs)?.[1] ?? "";
          const type = /t="(\w+)"/.exec(attrs)?.[1];
          let v: string;
          if (type === "s") v = shared[Number(/<v>([\s\S]*?)<\/v>/.exec(inner)?.[1])] ?? "";
          else if (type === "inlineStr") v = [...inner.matchAll(/<t(?: [^>]*)?>([\s\S]*?)<\/t>/g)].map((m) => decodeXml(m[1]!)).join("");
          else v = decodeXml(/<v>([\s\S]*?)<\/v>/.exec(inner)?.[1] ?? "");
          if (v === "") continue;
          const idx = ref ? colIndex(ref) : cells.length;
          while (cells.length < idx) cells.push("");
          cells[idx] = v;
        }
        if (cells.length) rows.push(cells.join("\t"));
      }
      return [`## Sheet: ${names[i] ?? `Sheet${n}`}`, ...rows].join("\n");
    })
    .join("\n\n");
}
