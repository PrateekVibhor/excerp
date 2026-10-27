/**
 * R1 run (plan 16, phase 3): for each role, orders the role's concepts (from the R0 results) with approaches A, B and C, three times each so
 * stability can be measured, plus a baseline that is just "most critical first". Token cost only, no Tavily credits.
 *   node --env-file=.env research/r1Run.ts "product manager" "data analyst" ...
 * Writes research/out/r1/<role>.json.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createNebiusChat, type TokenUsage } from '../src/llm.ts';
import { hybridOrder, stageOrder, topoOrder } from './r1Logic.ts';
import { askPrerequisites, askStages } from './r1Models.ts';

const REPEATS = 3;
const here = new URL('.', import.meta.url).pathname;
const slug = (role: string) => role.replace(/[^a-z0-9]+/gi, '-').toLowerCase();

async function once<T>(label: string, run: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await run();
    } catch (error) {
      if (attempt === 2) throw new Error(`${label} failed twice: ${(error as Error).message}`);
    }
  }
}

async function runRole(role: string) {
  const r0 = JSON.parse(readFileSync(`${here}out/r0-${slug(role)}.json`, 'utf8')) as { ranked: Array<{ skill: string; mentions: number; of: number; band: string }> };
  const concepts = r0.ranked.map((r) => r.skill);
  const mentions = Object.fromEntries(r0.ranked.map((r) => [r.skill, r.mentions]));
  const priority = (c: string) => mentions[c] ?? 0;
  const tokens = { in: 0, out: 0, calls: 0 };
  const chat = createNebiusChat({
    apiKey: process.env.NEBIUS_API_KEY!.trim(), model: process.env.NEBIUS_MODEL!.trim(), maxTokens: 16_000, timeoutMs: 180_000,
    onUsage: (u: TokenUsage) => void ((tokens.in += u.prompt_tokens), (tokens.out += u.completion_tokens), tokens.calls++),
  });
  const repeats = [];
  for (let i = 0; i < REPEATS; i++) {
    const [edges, stages] = await Promise.all([once('prerequisites', () => askPrerequisites(chat, role, concepts)), once('stages', () => askStages(chat, role, concepts))]);
    const a = topoOrder(concepts, edges, priority);
    repeats.push({ edges, stages, A: a.order, droppedEdges: a.droppedEdges, B: stageOrder(stages, priority), C: hybridOrder(stages, edges, priority) });
  }
  const baseline = [...concepts].sort((x, y) => priority(y) - priority(x) || x.localeCompare(y));
  mkdirSync(`${here}out/r1`, { recursive: true });
  writeFileSync(`${here}out/r1/${slug(role)}.json`, `${JSON.stringify({ role, date: new Date().toISOString(), concepts, mentions, of: r0.ranked[0]?.of ?? 0, baseline, repeats, tokens }, null, 1)}\n`);
  console.log(role, 'concepts', concepts.length, 'tokens', tokens.in + tokens.out, 'dropped edges', repeats.map((r) => r.droppedEdges.length).join('/'));
}

const roles = process.argv.slice(2);
const queue = [...roles];
await Promise.all(
  Array.from({ length: Math.min(4, roles.length) }, async () => {
    for (let role = queue.shift(); role; role = queue.shift()) {
      try {
        await runRole(role);
      } catch (error) {
        console.log(role, 'FAILED', (error as Error).message);
      }
    }
  }),
);
console.log('R1-RUN-FINISHED');
