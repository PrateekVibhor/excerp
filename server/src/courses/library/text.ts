// Plan 16, part 3, step B: the text of a library source, for the length of one run. Fetched, read and handed back; never written to the database or the
// repository (owner decision, 2026-10-17: what compounds is the list of vetted sources and the short facts, not the source text).
import { extractText, getDocumentProxy } from 'unpdf';

const ENTITIES: Record<string, string> = { nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", rsquo: '’', lsquo: '‘', ldquo: '“', rdquo: '”', ndash: '–', mdash: '—', hellip: '…', copy: '©' };

export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|noscript|head)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
      if (e[0] === '#') return String.fromCodePoint(e[1]!.toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
      return ENTITIES[e.toLowerCase()] ?? m;
    })
    .replace(/\s+/g, ' ')
    .trim();
}

export async function pdfToText(bytes: Uint8Array): Promise<string> {
  const { text } = await extractText(await getDocumentProxy(bytes), { mergePages: true });
  return text.replace(/\s+/g, ' ').trim();
}

export type SourceText = { ok: true; id: string; text: string; kind: 'html' | 'pdf' } | { ok: false; id: string; reason: string };
type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;

/** Fetches a source the pipeline may read and returns its text; a source it may not read is not fetched, and a failure is a reason, not a throw. */
export async function fetchSourceText(source: { id: string; url: string; pipeline_readable: boolean }, fetcher: Fetcher = fetch): Promise<SourceText> {
  const { id } = source;
  if (!source.pipeline_readable) return { ok: false, id, reason: 'not readable by the pipeline (needs a free account)' };
  try {
    const res = await fetcher(source.url, { redirect: 'follow', signal: AbortSignal.timeout(60_000), headers: { 'user-agent': 'Mozilla/5.0 (compatible; ExcerpLibraryCheck/1.0)' } });
    if (!res.ok) return { ok: false, id, reason: `HTTP ${res.status}` };
    const type = res.headers.get('content-type') ?? '';
    const pdf = /pdf/i.test(type) || /\.pdf($|\?)/i.test(source.url);
    const text = pdf ? await pdfToText(new Uint8Array(await res.arrayBuffer())) : htmlToText(await res.text());
    return text ? { ok: true, id, text, kind: pdf ? 'pdf' : 'html' } : { ok: false, id, reason: 'no readable text' };
  } catch (error) {
    return { ok: false, id, reason: (error as Error).message };
  }
}
