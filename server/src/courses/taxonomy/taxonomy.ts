// Posting-driven library, step 1: the transferable skill categories a role's postings map to, and the tools that point at a category instead of
// becoming one. Read from a JSON file for now (the database copy comes with the library's move to the database); validated before use.
import { readFileSync } from 'node:fs';

export interface Category {
  /** Set when read from the database: a category the mapper proposed stays "proposed" until a person accepts or merges it. */
  status?: 'active' | 'proposed' | 'merged';
  id: string;
  name: string;
  description: string;
  /** Plain phrases that, found as whole words in a posting phrase, name this category without asking a model. */
  aliases: string[];
}
export interface Tool {
  name: string;
  aliases: string[];
  /** The skill this tool is usually used for; a hint and the answer for a phrase that is only the tool. */
  category: string;
}
export interface Taxonomy {
  role: string;
  note?: string;
  categories: Category[];
  tools: Tool[];
  /** Worked cases for the easy-to-confuse phrases, shown to the model. */
  examples?: Array<{ phrase: string; category: string }>;
  /** Terms that are deliberately left unplaced (platform and infrastructure terms, personal traits, one-off phrases): a phrase holding one is not filed anywhere and the model is not asked. */
  unplaced?: string[];
}

export const loadTaxonomy = (file: string): Taxonomy => JSON.parse(readFileSync(file, 'utf8')) as Taxonomy;

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const wordPattern = (alias: string) => alias.trim().length === 1 ? new RegExp(`^\\s*${esc(alias.trim())}\\s*$`, 'i') : new RegExp(`(?<![a-z0-9])${alias.trim().split(/\s+/).map(esc).join('[\\s\\-/]+')}(?![a-z0-9])`, 'i');
const KEBAB = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export function validateTaxonomy(t: Taxonomy): string[] {
  const out: string[] = [];
  const ids = new Set<string>();
  const aliasOwner = new Map<string, string>();
  const toolWords = new Set(t.tools.flatMap((x) => [x.name, ...x.aliases]).map((x) => x.toLowerCase()));
  for (const c of t.categories) {
    if (!KEBAB.test(c.id)) out.push(`id "${c.id}" must be lower-case words joined by hyphens`);
    if (ids.has(c.id)) out.push(`duplicate category id "${c.id}"`);
    ids.add(c.id);
    if (!c.name.trim() || !c.description.trim()) out.push(`category "${c.id}" needs a name and a description`);
    if (toolWords.has(c.name.toLowerCase())) out.push(`category "${c.name}" is named after a tool`);
    for (const a of c.aliases.map((x) => x.toLowerCase())) {
      const other = aliasOwner.get(a);
      if (other && other !== c.id) out.push(`alias "${a}" is used by both ${other} and ${c.id}`);
      aliasOwner.set(a, c.id);
    }
  }
  const unplaced = t.unplaced ?? [];
  if (unplaced.some((u) => typeof u !== 'string' || !u.trim())) out.push('left-unplaced terms must be non-empty text');
  else for (const u of unplaced) {
    const owner = aliasOwner.get(u.trim().toLowerCase());
    if (owner) out.push(`"${u.trim().toLowerCase()}" is both an alias of ${owner} and left unplaced`);
  }
  for (const e of t.examples ?? []) if (!ids.has(e.category)) out.push(`example "${e.phrase}" names a category that does not exist: ${e.category}`);
  for (const tool of t.tools) if (!ids.has(tool.category)) out.push(`tool "${tool.name}" maps to a category that does not exist: ${tool.category}`);
  return out;
}

/** Every category a phrase names through an alias, in taxonomy order (a phrase can be about two skills at once); none when no alias matches. */
export function aliasCategories(t: Taxonomy, phrase: string): string[] {
  return t.categories.filter((c) => c.aliases.some((a) => wordPattern(a).test(phrase))).map((c) => c.id);
}

/** The tools named in a phrase (display names), in the order they appear. */
export function detectTools(t: Taxonomy, phrase: string): string[] {
  const found: Array<{ name: string; at: number }> = [];
  for (const tool of t.tools) {
    const at = Math.min(...[tool.name, ...tool.aliases].map((a) => wordPattern(a).exec(phrase)?.index ?? Infinity));
    if (at !== Infinity) found.push({ name: tool.name, at });
  }
  return found.sort((a, b) => a.at - b.at).map((f) => f.name);
}

/** True when the phrase holds a term the taxonomy leaves unplaced. */
export const holdsUnplaced = (t: Taxonomy, phrase: string): boolean => (t.unplaced ?? []).some((u) => typeof u === 'string' && u.trim() && wordPattern(u).test(phrase));
export const toolPattern = wordPattern;
