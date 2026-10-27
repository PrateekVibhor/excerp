// Plan 16, phase 4, stage 5: merge the names a role's postings use for the same skill or scenario and rank them by how many postings ask
// for them (spec decision 5: 60% and 25%, two mentions to be kept). Criticality comes from this function only; it takes no reference material.
import type { Chat } from '../../llm.ts';
import { BANDS, normSkill, type Band } from './matching.ts';
import { mergeSkillNames } from './merge.ts';

export interface PostingEvidence {
  skills: string[];
  scenarios: string[];
  /** False for a posting the reader added themselves: it can add a concept but never counts as a mention. */
  countsForCriticality: boolean;
}

export interface ConceptEvidence {
  kind: 'skill' | 'scenario';
  name: string;
  /** Every name the postings used for it, the reader's own posting included: it is how the reader's wording finds its concept in this build. */
  terms: string[];
  /**
   * The names (a subset of `terms`) that a public posting actually used. A shared concept row carries only these: a reader's own wording is never stored on a row that outlives
   * their list. Empty for a concept only the reader's posting asks for.
   */
  publicTerms?: string[];
  mentions: number;
  of: number;
  criticality: Band | null;
  /** Only the reader's own posting asks for it. */
  fromReaderSource: boolean;
  /** The tools the reader's posting named for a concept that stands for a transferable skill (kept as a note), and the skill category it was gathered under. */
  tools?: string[];
  category?: string;
}

export async function buildConcepts(chat: Chat, postings: PostingEvidence[]): Promise<ConceptEvidence[]> {
  const counting = postings.filter((p) => p.countsForCriticality);
  const out: ConceptEvidence[] = [];
  for (const kind of ['skill', 'scenario'] as const) {
    const pick = (p: PostingEvidence) => (kind === 'skill' ? p.skills : p.scenarios).map(normSkill).filter(Boolean);
    const names = [...new Set(postings.flatMap(pick))];
    const groups = names.length ? await mergeSkillNames(chat, names) : {};
    // A group's name must be one a public posting used. The model may name a group with the reader's phrase, or with a name nobody used, so the rule is kept here, not in the prompt:
    // such a name is replaced by the public name in the group that most public postings used, then the alphabetically first. A group of reader phrases only keeps its own name.
    const publicCount = new Map<string, number>();
    for (const p of counting) for (const n of new Set(pick(p))) publicCount.set(n, (publicCount.get(n) ?? 0) + 1);
    const members = new Map<string, string[]>();
    for (const n of names) members.set(groups[n] ?? n, [...(members.get(groups[n] ?? n) ?? []), n]);
    const finalName = new Map<string, string>();
    for (const [g, group] of members) {
      const used = group.filter((n) => publicCount.has(n));
      finalName.set(g, used.length === 0 || publicCount.has(g) ? g : used.sort((a, b) => publicCount.get(b)! - publicCount.get(a)! || a.localeCompare(b))[0]!);
    }
    const canon = (s: string) => finalName.get(groups[s] ?? s) ?? s;
    const terms = new Map<string, Set<string>>();
    const publicTerms = new Map<string, Set<string>>();
    for (const name of names) {
      (terms.get(canon(name)) ?? terms.set(canon(name), new Set()).get(canon(name))!).add(name);
      if (publicCount.has(name)) (publicTerms.get(canon(name)) ?? publicTerms.set(canon(name), new Set()).get(canon(name))!).add(name);
    }

    const mentions = new Map<string, number>();
    for (const p of counting) for (const c of new Set(pick(p).map(canon))) mentions.set(c, (mentions.get(c) ?? 0) + 1);
    const of = counting.length;
    for (const [name, count] of mentions) {
      if (count < BANDS.minMentions) continue;
      const share = count / of;
      out.push({ kind, name, terms: [...terms.get(name)!], publicTerms: [...(publicTerms.get(name) ?? [])], mentions: count, of, criticality: share >= BANDS.high ? 'high' : share >= BANDS.medium ? 'medium' : 'low', fromReaderSource: false });
    }
    // Concepts only the reader's own posting asks for: kept, marked, with no badge.
    for (const [name, t] of terms) if (!mentions.has(name)) out.push({ kind, name, terms: [...t], publicTerms: [], mentions: 0, of, criticality: null, fromReaderSource: true });
  }
  return out.sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'skill' ? -1 : 1) || b.mentions - a.mentions || a.name.localeCompare(b.name));
}
