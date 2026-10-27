// Plan 16, part 3, step B: reading a library source's text. The text is read for the length of one run and never stored: these functions only
// return it. The fetch is injected, so nothing here touches the network.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fetchSourceText, htmlToText, pdfToText } from './text.ts';

/** A one-page PDF with one line of text, written by hand (the cross-reference table is left for the reader to rebuild, as many real files need). */
function tinyPdf(line: string): Uint8Array {
  const stream = `BT /F1 12 Tf 10 50 Td (${line}) Tj ET`;
  const body = [
    '%PDF-1.4',
    '1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj',
    '2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj',
    '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 400 100]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj',
    `4 0 obj<</Length ${stream.length}>>stream\n${stream}\nendstream endobj`,
    '5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj',
    'trailer<</Root 1 0 R/Size 6>>',
    '%%EOF',
  ].join('\n');
  return new TextEncoder().encode(body);
}

test('html becomes plain text: scripts, styles and tags go, entities are decoded, space is squeezed', () => {
  const html = '<html><head><title>T</title><style>p{color:red}</style><script>var x = "stakeholder";</script></head><body><nav>Menu</nav><h1>Stakeholder&nbsp;analysis</h1><p>It&rsquo;s a &amp; b.</p><noscript>enable js</noscript></body></html>';
  const text = htmlToText(html);
  assert.ok(text.includes('Stakeholder analysis'));
  assert.ok(text.includes('It’s a & b.'));
  assert.ok(!/var x|color:red|enable js|<h1>/.test(text), text);
});

test('a PDF is read into its text', async () => {
  assert.match(await pdfToText(tinyPdf('Stakeholder analysis is a core practice.')), /Stakeholder analysis is a core practice\./);
});

test('fetchSourceText reads a page or a PDF by its content type, from the source url, and returns text without keeping it anywhere', async () => {
  const seen: string[] = [];
  const fetcher = async (url: string) => {
    seen.push(url);
    return url.endsWith('.pdf')
      ? new Response(tinyPdf('Requirements elicitation uses interviews.') as unknown as BodyInit, { status: 200, headers: { 'content-type': 'application/pdf' } })
      : new Response('<p>Roadmap planning links goals to work.</p>', { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });
  };
  const page = await fetchSourceText({ id: 'a', url: 'https://example.org/page', pipeline_readable: true }, fetcher);
  const pdf = await fetchSourceText({ id: 'b', url: 'https://example.org/doc.pdf', pipeline_readable: true }, fetcher);
  assert.deepEqual([page.ok, pdf.ok], [true, true]);
  assert.match((page as { text: string }).text, /Roadmap planning/);
  assert.match((pdf as { text: string }).text, /Requirements elicitation/);
  assert.deepEqual(seen, ['https://example.org/page', 'https://example.org/doc.pdf']);
});

test('a source the pipeline may not read is not fetched at all, and a failure says why instead of throwing', async () => {
  let calls = 0;
  const fetcher = async (): Promise<Response> => (calls++, new Response('no', { status: 403 }));
  assert.deepEqual(await fetchSourceText({ id: 'c', url: 'https://example.org/c', pipeline_readable: false }, fetcher), { ok: false, id: 'c', reason: 'not readable by the pipeline (needs a free account)' });
  assert.equal(calls, 0);
  assert.deepEqual(await fetchSourceText({ id: 'd', url: 'https://example.org/d', pipeline_readable: true }, fetcher), { ok: false, id: 'd', reason: 'HTTP 403' });
  const boom = async (): Promise<Response> => { throw new Error('network down'); };
  assert.deepEqual(await fetchSourceText({ id: 'e', url: 'https://example.org/e', pipeline_readable: true }, boom), { ok: false, id: 'e', reason: 'network down' });
  const empty = async () => new Response('<script>x</script>', { status: 200, headers: { 'content-type': 'text/html' } });
  assert.deepEqual(await fetchSourceText({ id: 'f', url: 'https://example.org/f', pipeline_readable: true }, empty), { ok: false, id: 'f', reason: 'no readable text' });
});
