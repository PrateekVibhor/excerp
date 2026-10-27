import { extractJson, type Chat } from '../../llm.ts';
import { normSkill } from './matching.ts';

const SYSTEM = `Group skill names that a hiring manager would treat as the same competency (for example "sql" and "writing sql queries"; "cross-functional collaboration" and "working with cross-functional teams"). Merge only names that are the same competency, or the same thing written differently. Never merge a tool with its whole category, or different skills that are merely related. Most groups have 2 to 4 names. Reply with one JSON object only: {"groups": [{"name": string, "variants": [strings]}]}. List ONLY groups that have two or more names; leave every other name out. Use only names from the input.`;

/** The most names one group may hold. */
const MAX_GROUP = 6;

/**
 * Maps each skill name the model groups with others to the group's name. Names outside every group are
 * absent from the result (they stand for themselves). A failed call returns {}, which leaves all unmerged.
 */
export async function mergeSkillNames(chat: Chat, names: string[]): Promise<Record<string, string>> {
  const known = new Set(names.map(normSkill));
  const map: Record<string, string> = {};
  try {
    const reply = await chat([
      { role: 'system', content: SYSTEM },
      { role: 'user', content: JSON.stringify(names) },
    ]);
    for (const g of ((extractJson(reply) as any).groups ?? []) as { name: string; variants?: string[] }[]) {
      const name = normSkill(String(g.name));
      const members = [...new Set([name, ...(g.variants ?? []).map((x) => normSkill(String(x)))])].filter((v) => known.has(v));
      if (members.length > MAX_GROUP) continue; // a group this big is merging related skills, not one skill
      for (const v of members) map[v] = name;
    }
  } catch {
    return {};
  }
  return map;
}
