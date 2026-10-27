/** R2: the web-checkable labelling sample for backend software engineer, ML engineer, forward-deployed engineer and project manager grounded chapters (out/r2/labels-core.md + hidden key). */
import { readFileSync, writeFileSync } from 'node:fs';

const here = new URL('.', import.meta.url).pathname;
const read = (f: string) => JSON.parse(readFileSync(`${here}out/r2/${f}`, 'utf8'));
const chapters = read('chapters.json') as Array<{ id: string; role: string; concept: string }>;
const claims = read('claims.json') as Record<string, { on: Array<{ text: string; category: string | null; supported: boolean }> }>;
const ROLES = ['backend software engineer', 'ML engineer', 'forward-deployed engineer', 'project manager'];
const PER_ROLE = 15;
const study = /\b(study|survey|report|according to|found that|research|benchmark|paper)\b/i;
const technical = /\b[A-Z]{2,}[A-Za-z0-9]*\b|[A-Za-z]+[A-Z][a-z]+\w*|\b\w+\.(js|py|io|ai)\b|\b(HTTP|TLS|SQL|API|REST|RFC|OWASP|ISO|SOC|GDPR|CAP theorem|PyTorch|TensorFlow|Kubernetes|Docker|PMBOK|Agile|Scrum|Kanban)\b/;
const clutter = /(per (user|seat|tenant|month|year)|free trial|starts? at|costs? \$|plans start|salary|average pay|pay range|\bcredit\b|job seekers|reached at|\d{3}\.\d{3}\.\d{4}|appeared on)/i;
const vague = /^(the|a|an)? ?(approach|team|analyst|engineer|manager|process)\b.{0,40}$/i;
let seed = 23;
const rand = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
const shuffle = <T>(xs: T[]) => { const o = [...xs]; for (let i = o.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [o[i], o[j]] = [o[j]!, o[i]!]; } return o; };

const final: Array<{ role: string; concept: string; claim: string; kind: string; chapter: string; spanSupported: boolean; category: string | null }> = [];
const pools: string[] = [];
for (const role of ROLES) {
  const rows = chapters.filter((c) => c.role === role).flatMap((c) => (claims[c.id]?.on ?? []).map((k) => ({ role, concept: c.concept, claim: k.text, chapter: c.id, spanSupported: k.supported, category: k.category })))
    .filter((r) => !clutter.test(r.claim) && !vague.test(r.claim) && r.claim.length > 40)
    .filter((r, i, all) => all.findIndex((o) => o.claim.toLowerCase() === r.claim.toLowerCase()) === i); // the same sentence can come from two chapters
  const studies = rows.filter((r) => /\d/.test(r.claim) && study.test(r.claim));
  const isStudy = new Set(studies);
  const figures = rows.filter((r) => !isStudy.has(r) && /\d/.test(r.claim));
  const isFigure = new Set(figures);
  const facts = rows.filter((r) => !isStudy.has(r) && !isFigure.has(r) && technical.test(r.claim));
  pools.push(`${role}: study ${studies.length}, figure ${figures.length}, technical fact ${facts.length}`);
  const pick: Array<(typeof rows)[number] & { kind: string }> = [];
  const take = (list: typeof rows, kind: string, max: number) => { for (const r of shuffle(list)) if (pick.length < PER_ROLE && max-- > 0 && !pick.some((p) => p === (r as unknown))) pick.push({ ...r, kind }); };
  take(studies, 'study figure', 5);
  take(figures, 'figure', 5);
  take(facts, 'technical fact', PER_ROLE);
  take(rows.filter((r) => !pick.some((p) => p.claim === r.claim)), 'extra', PER_ROLE);
  final.push(...pick.slice(0, PER_ROLE));
}
const out = shuffle(final).map((r, i) => ({ ...r, n: i + 1 }));
writeFileSync(`${here}out/r2/labels-core.md`, [
  '# R2 claim labelling, backend software engineer, ML engineer, forward-deployed engineer, project manager (checkable by web search)', '',
  `${out.length} claims from short teaching chapters: specific numbers, named studies or sources, and concrete technical facts. You do not need to know the roles; look each claim up (a web search is enough).`,
  'Write after "label:" exactly one of: right (what you find supports it as stated), wrong (what you find contradicts it, or it is wrong or too absolute), unsure (you could not find it either way or it depends on the situation). If a claim says "according to <a study>" and you cannot find that study, write unsure; if the study exists but says something different, write wrong.', '',
  ...out.map((r) => `${r.n}. [${r.role}: ${r.concept}] ${r.claim} | label:`), '',
].join('\n'));
writeFileSync(`${here}out/r2/labels-core-key.json`, `${JSON.stringify(out.map(({ n, role, kind, category, spanSupported, chapter }) => ({ n, role, kind, category, spanSupported, chapter })), null, 1)}\n`);
console.log('pools', pools.join(' | '));
console.log('claims', out.length, ROLES.map((r) => `${r} ${out.filter((x) => x.role === r).length}`).join(', '), '| kinds', ['study figure', 'figure', 'technical fact', 'extra'].map((k) => `${k} ${out.filter((x) => x.kind === k).length}`).join(', '), '| span-supported', out.filter((x) => x.spanSupported).length);
