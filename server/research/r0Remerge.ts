/**
 * Re-runs only the skill merge and ranking on a saved r0-<role>.json (no Tavily credits, model tokens only):
 *   node --env-file=.env research/r0Remerge.ts research/out/r0-data-analyst.json
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { createNebiusChat } from '../src/llm.ts';
import { mergeSkillNames } from './r0Merge.ts';
import { normSkill, rankSkills } from './r0Logic.ts';

const file = process.argv[2]!;
const out = JSON.parse(readFileSync(file, 'utf8'));
const chat = createNebiusChat({ apiKey: process.env.NEBIUS_API_KEY!.trim(), model: process.env.NEBIUS_MODEL!.trim(), maxTokens: 16_000, timeoutMs: 120_000 });
const names = [...new Set((out.postings as { skills: string[] }[]).flatMap((p) => p.skills.map(normSkill)).filter(Boolean))] as string[];
const groups = await mergeSkillNames(chat, names);
const canon = (s: string) => groups[normSkill(s)] ?? normSkill(s);
out.mergeFailed = names.length > 0 && Object.keys(groups).length === 0;
out.rawSkillNames = names.length;
out.mergedSkills = new Set(names.map(canon)).size;
out.ranked = rankSkills((out.postings as { skills: string[] }[]).map((p) => ({ skills: p.skills.map(canon) })));
writeFileSync(file, `${JSON.stringify(out, null, 2)}\n`);
console.log(file, 'raw', out.rawSkillNames, 'merged', out.mergedSkills, 'kept', out.ranked.length, 'mergeFailed', out.mergeFailed);
