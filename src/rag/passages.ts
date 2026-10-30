/**
 * Page Markdown -> passages (issue #365).
 *
 * A reader model (PaddleOCR-VL) turns each PDF page into Markdown. Tables come back
 * as HTML `<table>`, as OTSL tokens (`<fcel>cell<nl>`), or as Markdown pipe tables;
 * all three become one line per row with cells joined by " | ". Passages stay on
 * one page, follow headings, and a long table is split by rows with its header row
 * repeated, so a row never loses its column names.
 *
 * Ported from chatbots `copilot-engine/tools/paddle_passages.py`.
 */

export interface Passage {
  page: number;
  text: string;
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

function unescapeHtml(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, name: string) => {
    if (name[0] === '#') {
      const code = name[1] === 'x' || name[1] === 'X' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[name.toLowerCase()] ?? whole;
  });
}

function clean(text: string): string {
  return unescapeHtml(text.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

/** HTML table -> one line per row, cells joined by " | ". */
export function htmlTableRows(table: string): string[] {
  const rows: string[] = [];
  const trRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let tr: RegExpExecArray | null;
  while ((tr = trRe.exec(table)) !== null) {
    const cells: string[] = [];
    const cellRe = /<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi;
    let cell: RegExpExecArray | null;
    while ((cell = cellRe.exec(tr[1]!)) !== null) cells.push(clean(cell[1]!));
    if (cells.some((c) => c.length > 0)) rows.push(cells.join(' | '));
  }
  return rows;
}

const OTSL_CELL = /<(fcel|ecel|lcel|ucel|xcel|ched|rhed|srow)>/;

/** OTSL table -> rows. Merged-cell markers (lcel/ucel/xcel) carry no text and are dropped. */
export function otslTableRows(table: string): string[] {
  const body = table.replace(/<\/?otsl>/gi, '');
  const rows: string[] = [];
  for (const line of body.split(/<nl>/i)) {
    const cells: string[] = [];
    const parts = line.split(/(<(?:fcel|ecel|lcel|ucel|xcel|ched|rhed|srow)>)/i);
    for (let i = 1; i < parts.length; i += 2) {
      const tag = parts[i]!.toLowerCase();
      if (tag === '<lcel>' || tag === '<ucel>' || tag === '<xcel>') continue;
      cells.push(clean(parts[i + 1] ?? ''));
    }
    if (cells.some((c) => c.length > 0)) rows.push(cells.join(' | '));
  }
  return rows;
}

function pipeTableRows(lines: string[]): string[] {
  return lines
    .filter((l) => !/^\s*\|?[\s:|-]+\|?\s*$/.test(l)) // the |---|---| separator
    .map((l) =>
      l
        .trim()
        .replace(/^\||\|$/g, '')
        .split('|')
        .map((c) => clean(c))
        .join(' | ')
    )
    .filter((r) => r.replace(/[\s|]/g, '').length > 0);
}

interface Block {
  heading: string;
  lines: string[];
  isTable: boolean;
}

/** Splits page Markdown into heading-tagged paragraph and table blocks. */
export function blocks(md: string): Block[] {
  const out: Block[] = [];
  let heading = '';
  const tableRe = /(<table[\s\S]*?<\/table>|<otsl>[\s\S]*?<\/otsl>|(?:<(?:fcel|ecel|ched|rhed|srow)>[\s\S]*?<nl>)+)/gi;
  for (const part of md.replace(/\r\n/g, '\n').split(tableRe)) {
    if (!part) continue;
    if (/^<table/i.test(part)) {
      out.push({ heading, lines: htmlTableRows(part), isTable: true });
      continue;
    }
    if (/^<otsl>/i.test(part) || OTSL_CELL.test(part.slice(0, 8))) {
      out.push({ heading, lines: otslTableRows(part), isTable: true });
      continue;
    }
    for (const para of part.split(/\n\s*\n/)) {
      const p = para.trim();
      if (!p) continue;
      const paraLines = p.split('\n');
      if (paraLines.length >= 2 && paraLines.every((l) => l.trim().startsWith('|'))) {
        out.push({ heading, lines: pipeTableRows(paraLines), isTable: true });
        continue;
      }
      let rest = p;
      if (p.startsWith('#')) {
        heading = paraLines[0]!.replace(/^#+\s*/, '').trim();
        rest = paraLines.slice(1).join('\n');
      }
      // Keep line breaks: whole-page OCR prints one table row per line, with wide
      // gaps between columns, which become " | " like the other table formats.
      const text = rest
        .split('\n')
        .map((l) => clean(l.replace(/[ \t]{3,}/g, ' | ')))
        .filter((l) => l.length > 0)
        .join('\n');
      if (text) out.push({ heading, lines: [text], isTable: false });
    }
  }
  return out.filter((b) => b.lines.length > 0);
}

/**
 * Page Markdown -> passages of at most about `maxChars`, each tagged with its page.
 * The default stays under the 800-character chunk, so indexing never re-splits one.
 */
export function passages(md: string, page: number, maxChars = 650): Passage[] {
  const out: Passage[] = [];
  const withHead = (head: string, lines: string[]) => (head ? `${head}\n` : '') + lines.join('\n');
  let buf: string[] = [];
  let head = '';
  const len = (lines: string[]) => lines.reduce((n, l) => n + l.length, 0);
  const flush = () => {
    if (buf.length > 0) out.push({ page, text: withHead(head, buf) });
    buf = [];
  };

  for (const block of blocks(md)) {
    if (block.isTable) {
      flush();
      head = block.heading;
      const top = block.lines.slice(0, 1);
      let piece = [...top];
      for (const row of block.lines.slice(1)) {
        if (len(piece) + row.length > maxChars && piece.length > 1) {
          out.push({ page, text: withHead(block.heading, piece) });
          piece = [...top];
        }
        piece.push(row);
      }
      out.push({ page, text: withHead(block.heading, piece) });
      continue;
    }
    const line = block.lines[0]!;
    if (block.heading !== head || len(buf) + line.length > maxChars) {
      flush();
      head = block.heading;
    }
    buf.push(line);
  }
  flush();
  return out;
}

const NUM = /\d[\d,]*(?:\.\d+)?/g;

/**
 * Numbers in a passage that the page's own PDF text layer does not contain
 * (commas ignored). A non-empty result means the reader may have misread a number,
 * so the passage is not indexed.
 */
export function unknownNumbers(text: string, textLayer: string): string[] {
  const have = new Set((textLayer.match(NUM) ?? []).map((n) => n.replace(/,/g, '')));
  const unknown = (text.match(NUM) ?? []).filter((n) => !have.has(n.replace(/,/g, '')));
  return unknown.filter((n, i) => unknown.indexOf(n) === i).sort();
}
