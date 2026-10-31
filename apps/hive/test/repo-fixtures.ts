/** Builders for M3 test fixtures: throwaway git repos and real (minimal) Office/PDF files. */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { strToU8, zipSync } from "fflate";

export function sh(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    env: { ...process.env, GIT_AUTHOR_NAME: "T", GIT_AUTHOR_EMAIL: "t@x", GIT_COMMITTER_NAME: "T", GIT_COMMITTER_EMAIL: "t@x" },
  });
}

/** A temp root (stands in for ~/dev) holding one git repo with an origin remote. */
export function makeRepo(files: Record<string, string | Uint8Array>, opts: { remote?: string } = {}) {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "hive-repos-")));
  const dir = path.join(root, "proj");
  mkdirSync(dir);
  sh(dir, "init", "-q", "-b", "main");
  if (opts.remote !== undefined) sh(dir, "remote", "add", "origin", opts.remote);
  write(dir, files);
  commit(dir, "initial import");
  return { root, dir, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

export function write(dir: string, files: Record<string, string | Uint8Array>) {
  for (const [rel, body] of Object.entries(files)) {
    const f = path.join(dir, rel);
    mkdirSync(path.dirname(f), { recursive: true });
    writeFileSync(f, body);
  }
}

export function commit(dir: string, message: string) {
  sh(dir, "add", "-A");
  sh(dir, "commit", "-q", "--allow-empty", "-m", message);
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function docx(paragraphs: string[]): Uint8Array {
  const body = paragraphs.map((p) => `<w:p><w:r><w:t xml:space="preserve">${esc(p)}</w:t></w:r></w:p>`).join("");
  return zipSync({
    "[Content_Types].xml": strToU8('<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>'),
    "word/document.xml": strToU8(
      `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`,
    ),
  });
}

export function pptx(slides: { lines: string[]; notes?: string }[]): Uint8Array {
  const files: Record<string, Uint8Array> = {
    "ppt/presentation.xml": strToU8('<?xml version="1.0"?><p:presentation xmlns:p="p"/>'),
  };
  slides.forEach((s, i) => {
    const paras = s.lines.map((l) => `<a:p><a:r><a:t>${esc(l)}</a:t></a:r></a:p>`).join("");
    files[`ppt/slides/slide${i + 1}.xml`] = strToU8(`<?xml version="1.0"?><p:sld xmlns:a="a" xmlns:p="p"><p:txBody>${paras}</p:txBody></p:sld>`);
    if (s.notes) {
      files[`ppt/notesSlides/notesSlide${i + 1}.xml`] = strToU8(
        `<?xml version="1.0"?><p:notes xmlns:a="a" xmlns:p="p"><a:p><a:r><a:t>${i + 1}</a:t></a:r></a:p><a:p><a:r><a:t>${esc(s.notes)}</a:t></a:r></a:p></p:notes>`,
      );
    }
  });
  return zipSync(files);
}

/** One sheet; cells given as rows of strings/numbers. Strings go through sharedStrings like Excel writes them. */
export function xlsx(sheetName: string, rows: (string | number)[][]): Uint8Array {
  const shared: string[] = [];
  const cols = "ABCDEFGHIJ";
  const rowXml = rows
    .map((r, ri) => {
      const cells = r
        .map((v, ci) => {
          const ref = `${cols[ci]}${ri + 1}`;
          if (typeof v === "number") return `<c r="${ref}"><v>${v}</v></c>`;
          shared.push(v);
          return `<c r="${ref}" t="s"><v>${shared.length - 1}</v></c>`;
        })
        .join("");
      return `<row r="${ri + 1}">${cells}</row>`;
    })
    .join("");
  return zipSync({
    "xl/workbook.xml": strToU8(`<?xml version="1.0"?><workbook><sheets><sheet name="${esc(sheetName)}" sheetId="1"/></sheets></workbook>`),
    "xl/sharedStrings.xml": strToU8(`<?xml version="1.0"?><sst>${shared.map((s) => `<si><t>${esc(s)}</t></si>`).join("")}</sst>`),
    "xl/worksheets/sheet1.xml": strToU8(`<?xml version="1.0"?><worksheet><sheetData>${rowXml}</sheetData></worksheet>`),
  });
}

/** A valid one-page PDF. With `lines`, a real text layer (Helvetica); without, a page with no text (like a scan). */
export function pdf(lines: string[] = []): Buffer {
  const pdfEsc = (s: string) => s.replace(/[\\()]/g, (c) => `\\${c}`);
  const stream = lines.length
    ? `BT /F1 12 Tf 72 720 Td 14 TL ${lines.map((l) => `(${pdfEsc(l)}) '`).join(" ")} ET`
    : "0 0 1 rg 100 100 200 200 re f";
  const objs = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objs.forEach((o, i) => {
    offsets.push(Buffer.byteLength(out));
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out);
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

export function hasPdftotext(): boolean {
  try {
    execFileSync("pdftotext", ["-v"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}
