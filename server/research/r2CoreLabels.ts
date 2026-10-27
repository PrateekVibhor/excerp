/** R2: writes the owner's labels into labels-core.md and prints the rates (wrong; unsure with no source span; unsure that a source states). */
import { readFileSync, writeFileSync } from 'node:fs';
import { wilson } from './r1Logic.ts';

const here = new URL('.', import.meta.url).pathname;
const labels = process.argv[2]!.split(',').map((s) => s.trim());
const key = JSON.parse(readFileSync(`${here}out/r2/labels-core-key.json`, 'utf8')) as Array<{ n: number; role: string; kind: string; spanSupported: boolean }>;
if (labels.length !== key.length) throw new Error(`${labels.length} labels for ${key.length} claims`);
const file = `${here}out/r2/labels-core.md`;
const text = readFileSync(file, 'utf8');
if (/^\d+\. .*\| label:\s*$/m.test(text)) writeFileSync(file, text.replace(/^(\d+)\. (.*\| label:)\s*$/gm, (_m, n, rest) => `${n}. ${rest} ${labels[Number(n) - 1]}`));
const f = (k: number, n: number) => { const w = wilson(k, n); return `${k}/${n} = ${(w.rate * 100).toFixed(1)}% (${(w.low * 100).toFixed(1)}–${(w.high * 100).toFixed(1)}%)`; };
const rows = key.map((k) => ({ ...k, label: labels[k.n - 1]! }));
const show = (name: string, sel: typeof rows) => {
  const wrong = sel.filter((r) => r.label === 'wrong').length;
  const unsureNo = sel.filter((r) => r.label === 'unsure' && !r.spanSupported).length;
  const unsureYes = sel.filter((r) => r.label === 'unsure' && r.spanSupported).length;
  console.log(`${name}: n ${sel.length} | right ${sel.filter((r) => r.label === 'right').length} | wrong ${f(wrong, sel.length)} | unsure, no source span ${f(unsureNo, sel.length)} | unsure, a source states it ${f(unsureYes, sel.length)}`);
};
show('all', rows);
for (const role of [...new Set(key.map((k) => k.role))]) show(role, rows.filter((r) => r.role === role));
for (const kind of [...new Set(key.map((k) => k.kind))]) show(`kind ${kind}`, rows.filter((r) => r.kind === kind));
console.log('span-supported in sample', rows.filter((r) => r.spanSupported).length, '| wrong claims:', rows.filter((r) => r.label === 'wrong').map((r) => r.n).join(','));
