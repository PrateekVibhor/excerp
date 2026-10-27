/** R2: writes the owner's labels into labels-sample.md and prints rates by chapter version (grounded = on, from memory = off). */
import { readFileSync, writeFileSync } from 'node:fs';
import { wilson } from './r1Logic.ts';

const here = new URL('.', import.meta.url).pathname;
const labels = process.argv[2]!.split(',').map((s) => s.trim());
const key = JSON.parse(readFileSync(`${here}out/r2/labels-key.json`, 'utf8')) as Array<{ n: number; version: 'on' | 'off'; spanSupported: boolean }>;
if (labels.length !== key.length) throw new Error(`${labels.length} labels for ${key.length} claims`);
const file = `${here}out/r2/labels-sample.md`;
const text = readFileSync(file, 'utf8');
if (!/label:\s*$/m.test(text.split('\n').find((l) => /^1\. /.test(l))!)) console.log('labels already present, not rewriting the file');
else writeFileSync(file, text.replace(/^(\d+)\. (.*\| label:)\s*$/gm, (_m, n, rest) => `${n}. ${rest} ${labels[Number(n) - 1]}`));
const f = (k: number, n: number) => { const w = wilson(k, n); return `${k}/${n} = ${(w.rate * 100).toFixed(1)}% (${(w.low * 100).toFixed(1)}–${(w.high * 100).toFixed(1)}%)`; };
for (const v of ['on', 'off'] as const) for (const s of [true, false, null] as const) {
  const rows = key.filter((k) => k.version === v && (s === null || k.spanSupported === s));
  const c = (l: string) => rows.filter((k) => labels[k.n - 1] === l).length;
  console.log(v, s === null ? 'all' : s ? 'span-supported' : 'no span', 'n', rows.length, 'right', c('right'), 'unsure', c('unsure'), 'wrong', c('wrong'), '| wrong', f(c('wrong'), rows.length), '| wrong or unsure', f(c('wrong') + c('unsure'), rows.length));
}
