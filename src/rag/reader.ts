/**
 * PDF reading for file ingest (issue #365).
 *
 * Each page is rendered to PNG (poppler `pdftoppm`) and sent to a reader model
 * (PaddleOCR-VL served by llama.cpp `llama-server`, OpenAI-compatible) that returns
 * the page as Markdown with table rows kept together. The PDF's own text layer
 * (`pdftotext`) is read as well: it is the fallback when no reader is configured,
 * and the reference the number check compares passages against.
 *
 * Env:
 *   OCTO_READER_URL     OpenAI-compatible base URL, e.g. http://host.docker.internal:8090/v1
 *   OCTO_READER_MODEL   model name sent to the server (default paddleocr-vl)
 *   OCTO_READER_PROMPT  task prompt (default "OCR:")
 */

import { execFile } from 'child_process';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { promisify } from 'util';

const run = promisify(execFile);

export interface ReaderConfig {
  baseUrl: string;
  model: string;
  prompt: string;
}

export function loadReaderConfigFromEnv(): ReaderConfig | null {
  const baseUrl = process.env['OCTO_READER_URL'];
  if (!baseUrl) return null;
  return {
    baseUrl: baseUrl.replace(/\/+$/, ''),
    model: process.env['OCTO_READER_MODEL'] ?? 'paddleocr-vl',
    prompt: process.env['OCTO_READER_PROMPT'] ?? 'OCR:',
  };
}

export interface PdfPage {
  page: number;
  /** The PDF's own text layer for this page (empty for a scan). */
  textLayer: string;
  /** Reader Markdown, or null when no reader is configured. */
  markdown: string | null;
}

/** Sends one page image to the reader and returns its Markdown. */
export async function readPageImage(config: ReaderConfig, png: Buffer): Promise<string> {
  const response = await fetch(`${config.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: config.model,
      temperature: 0,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'image_url', image_url: { url: `data:image/png;base64,${png.toString('base64')}` } },
            { type: 'text', text: config.prompt },
          ],
        },
      ],
    }),
    signal: AbortSignal.timeout(10 * 60 * 1000),
  });
  if (!response.ok) {
    throw new Error(`reader returned ${response.status}: ${(await response.text()).slice(0, 200)}`);
  }
  const body = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
  return body.choices?.[0]?.message?.content ?? '';
}

/**
 * Reads every page of a PDF: its text layer always, and reader Markdown when a
 * reader is configured. Pages are numbered from 1, as in the PDF.
 */
export async function readPdf(bytes: Buffer, reader: ReaderConfig | null): Promise<PdfPage[]> {
  const dir = await mkdtemp(join(tmpdir(), 'octo-pdf-'));
  try {
    const pdf = join(dir, 'in.pdf');
    await writeFile(pdf, bytes);

    const { stdout } = await run('pdftotext', ['-layout', '-enc', 'UTF-8', pdf, '-'], {
      maxBuffer: 256 * 1024 * 1024,
    });
    // pdftotext ends every page with a form feed.
    const layers = stdout.split('\f');
    if (layers.length > 1 && layers[layers.length - 1]!.trim() === '') layers.pop();

    const pages: PdfPage[] = layers.map((textLayer, i) => ({ page: i + 1, textLayer, markdown: null }));
    if (!reader) return pages;

    await run('pdftoppm', ['-r', '150', '-png', pdf, join(dir, 'p')], { maxBuffer: 16 * 1024 * 1024 });
    // pdftoppm names pages p-1.png or p-01.png depending on the page count.
    const images = (await readdir(dir))
      .map((name) => ({ name, page: Number(/^p-(\d+)\.png$/.exec(name)?.[1]) }))
      .filter((f) => Number.isInteger(f.page) && f.page > 0)
      .sort((a, b) => a.page - b.page);

    for (const image of images) {
      const markdown = await readPageImage(reader, await readFile(join(dir, image.name)));
      const existing = pages[image.page - 1];
      if (existing) existing.markdown = markdown;
      else pages[image.page - 1] = { page: image.page, textLayer: '', markdown };
    }
    return pages.filter(Boolean);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
