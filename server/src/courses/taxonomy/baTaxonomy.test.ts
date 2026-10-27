// The business analyst taxonomy as it stands in the file: the widened "Industry and domain knowledge", the narrow "Programming and scripting for analysis", and that the
// phrases they are meant for are mapped by the file's own aliases and tools, the same way every time, whatever the model says (or fails to).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Chat } from '../../llm.ts';
import { mapPhrases } from './map.ts';
import { aliasCategories, loadTaxonomy, validateTaxonomy } from './taxonomy.ts';

const FILE = new URL('../../../reference-library/business-analyst/categories.json', import.meta.url).pathname;
const t = loadTaxonomy(FILE);
const cat = (id: string) => t.categories.find((c) => c.id === id)!;

test('the file is still a valid taxonomy, with one more category than before (24)', () => {
  assert.deepEqual(validateTaxonomy(t), []);
  assert.equal(t.categories.length, 24);
});

test('"Industry and domain knowledge" covers functional domains and standards, and says so with the aliases for them', () => {
  const k = cat('domain-knowledge');
  for (const word of ['treasury', 'payments', 'ISO 20022', 'HR']) assert.match(k.description, new RegExp(word, 'i'), word);
  for (const alias of ['iso 20022', 'treasury', 'payment systems', 'cash management', 'compensation and benefits', 'talent management', 'performance management', 'offboarding']) assert.ok(k.aliases.includes(alias), alias);
});

test('"Programming and scripting for analysis" is narrow: scripting languages and general programming, with Python, R and Visual Basic as its tools, and nothing on the platform side', () => {
  const k = cat('programming-scripting');
  assert.equal(k.name, 'Programming and scripting for analysis');
  for (const alias of ['python', 'r programming', 'vba', 'visual basic', 'scripting', 'programming']) assert.ok(k.aliases.includes(alias), alias);
  const tools = t.tools.filter((x) => x.category === 'programming-scripting').map((x) => x.name).sort();
  assert.deepEqual(tools, ['Python', 'R', 'Visual Basic']);
  assert.match(k.description, /not platform or infrastructure/i, 'the description tells the judge where the line is');
  const claims = JSON.stringify([k.aliases, t.tools.filter((x) => x.category === 'programming-scripting')]).toLowerCase();
  for (const platform of ['spark', 'hadoop', 'nosql', 'active directory', 'operating system', 'office 365', 'infrastructure', 'devops']) assert.ok(!claims.includes(platform), `${platform} is the platform side: no alias or tool claims it`);
});

/** A model that is wrong on purpose, differently every time: it names a different category on every call. */
function erratic(): Chat & { calls: number } {
  const ids = t.categories.map((c) => c.id);
  const chat = (async (m: Array<{ content: string }>) => {
    chat.calls++;
    const asked = (JSON.parse(m.at(-1)!.content) as { phrases: string[] }).phrases;
    return JSON.stringify({ results: asked.map((phrase, i) => ({ i, phrase, category: ids[(chat.calls * 7 + i) % ids.length] })) });
  }) as unknown as Chat & { calls: number };
  chat.calls = 0;
  return chat;
}
const down: Chat = async () => { throw new Error('model down'); };

const DOMAIN = ['payment systems iso 20022', 'treasury and cash‑management systems', 'Compensation and benefits administration', 'Performance management', 'Talent management', 'Offboarding', 'iso 20022 payment messaging'];
const PROGRAMMING = ['Python', 'Python programming', 'R programming', 'Visual Basic', 'Programming', 'VBA macros', 'scripting'];

test('the domain phrases map to domain knowledge, and the programming phrases to programming and scripting, by the file alone: the model is not needed and cannot change it', async () => {
  for (const chat of [down, erratic(), erratic()]) {
    const r = await mapPhrases(chat, t, [...DOMAIN, ...PROGRAMMING]);
    for (const m of r.mapped) {
      const expected = DOMAIN.includes(m.phrase) ? 'domain-knowledge' : 'programming-scripting';
      assert.deepEqual(m.categories, [expected], `${m.phrase} (${m.source})`);
    }
  }
});

test('tools: Python, R and Visual Basic named in a longer phrase are noted as tools and file under programming and scripting when the model has no better answer', async () => {
  const r = await mapPhrases(async () => JSON.stringify({ results: [{ i: 0, phrase: 'Python tooling', category: 'none' }] }), t, ['Python tooling']);
  assert.deepEqual([r.mapped[0]!.categories, r.mapped[0]!.tools], [['programming-scripting'], ['Python']]);
});

test('the platform side and the traits stay unplaced by the file: no alias or tool claims them', () => {
  for (const phrase of ['Apache Spark', 'NoSQL/Hadoop', 'Active Directory', 'Operating systems', 'Detail orientation', 'Computer skills', 'Bias for action', 'Multilingual translation']) {
    assert.deepEqual(aliasCategories(t, phrase), [], phrase);
  }
});

test('phrases that hold both a domain word and another category\'s word are still decided by the model, as before', async () => {
  const log: string[] = [];
  const chat: Chat = async (m) => {
    log.push('asked');
    const asked = (JSON.parse(m.at(-1)!.content) as { phrases: string[] }).phrases;
    return JSON.stringify({ results: asked.map((phrase, i) => ({ i, phrase, category: 'sql-data-querying', also: 'domain-knowledge' })) });
  };
  const r = await mapPhrases(chat, t, ['analyse payment and settlement data with sql and iso 20022 reporting']);
  assert.equal(log.length, 1);
  assert.equal(r.mapped[0]!.categories[0], 'sql-data-querying');
});

const LEFT_OUT = ['Apache Spark', 'NoSQL/Hadoop', 'Active Directory', 'Operating systems', 'Office 365', 'Detail orientation', 'Computer skills', 'Bias for action', 'Multilingual translation', 'ITIL service management'];

test('the platform side, the traits and the one-off phrases are named in the file as left unplaced, and the same phrases stay unplaced whatever the model says, or if it is down', async () => {
  assert.ok(t.unplaced && t.unplaced.length >= 10);
  for (const chat of [down, erratic(), erratic()]) {
    const r = await mapPhrases(chat, t, LEFT_OUT);
    for (const m of r.mapped) assert.deepEqual([m.categories, m.source], [[], 'left_out'], m.phrase);
  }
});

test('leaving a platform term unplaced never takes a real skill with it: SQL, Python and the domain words in the same phrase are still filed', async () => {
  const r = await mapPhrases(down, t, ['sql on Apache Spark', 'python scripts for Active Directory reports', 'iso 20022 payments on an operating system']);
  assert.deepEqual(r.mapped.map((m) => m.categories), [['sql-data-querying'], ['programming-scripting'], ['domain-knowledge']]);
});
