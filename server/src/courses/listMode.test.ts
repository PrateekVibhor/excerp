// List mode (plan 16, part 7): a course that is a sequenced list of concepts with real links, no written chapters. The pure parts: which roles may have
// one, how a concept's links rate (strong / thin / missing), the meter, and the short display name each concept gets.
import assert from 'node:assert/strict';
import { readdirSync, statSync } from 'node:fs';
import { test } from 'node:test';
import type { Chat } from '../llm.ts';
import { LIST_MODE_ROLES, conceptBand, displayNames, fallbackName, listModeAvailable, meterOf } from './listMode.ts';

test('list mode is open to the roles that have a library folder and to no others, and the list matches the folders on disk', () => {
  assert.deepEqual([...LIST_MODE_ROLES].sort(), ['business-analyst', 'forward-deployed-engineer', 'product-manager']);
  for (const name of ['business analyst', 'Business Analyst', 'product manager', 'forward-deployed engineer', 'forward deployed engineer']) assert.equal(listModeAvailable(name), true, name);
  for (const name of ['data analyst', 'ML engineer', 'backend software engineer', 'project manager', '']) assert.equal(listModeAvailable(name), false, name);
  const dir = new URL('../../reference-library', import.meta.url).pathname;
  const folders = readdirSync(dir).filter((n) => statSync(`${dir}/${n}`).isDirectory() && n !== 'snapshot');
  assert.deepEqual([...LIST_MODE_ROLES].sort(), folders.sort(), 'a new library folder must be added to the list-mode roles on purpose');
});

test('a concept is strong with two or more links of which at least one is a library source, thin with one link or only unvetted links, missing with none', () => {
  assert.equal(conceptBand({ library: 1, other: 1 }), 'strong');
  assert.equal(conceptBand({ library: 2, other: 0 }), 'strong');
  assert.equal(conceptBand({ library: 3, other: 4 }), 'strong');
  assert.equal(conceptBand({ library: 1, other: 0 }), 'thin');
  assert.equal(conceptBand({ library: 0, other: 1 }), 'thin');
  assert.equal(conceptBand({ library: 0, other: 4 }), 'thin', 'many unvetted links are still thin');
  assert.equal(conceptBand({ library: 0, other: 0 }), 'missing');
});

test('the meter counts the bands, the library-backed share and the share with any link', () => {
  const m = meterOf([{ band: 'strong', library: 2, other: 1 }, { band: 'thin', library: 0, other: 2 }, { band: 'thin', library: 1, other: 0 }, { band: 'missing', library: 0, other: 0 }]);
  assert.deepEqual(m, { total: 4, strong: 1, thin: 2, missing: 1, library_backed: 2, with_any_link: 3 });
  assert.deepEqual(meterOf([]), { total: 0, strong: 0, thin: 0, missing: 0, library_backed: 0, with_any_link: 0 });
});

test('the fallback name is the concept in sentence case, cut at a word', () => {
  assert.equal(fallbackName('sql'), 'Sql');
  assert.equal(fallbackName('stakeholder management'), 'Stakeholder management');
  const long = fallbackName('conduct customer interviews in fintech healthcare and hrtech contexts to uncover needs and then summarise them');
  assert.ok(long.length <= 60 && !long.endsWith(' ') && long.startsWith('Conduct customer interviews'), long);
});

const echo = (table: Record<string, string>, log: string[] = []): Chat => async (m) => {
  log.push(m.at(-1)!.content);
  const names = (JSON.parse(m.at(-1)!.content) as { skills: string[] }).skills;
  return JSON.stringify({ names: names.filter((n) => table[n] !== undefined).map((n) => ({ skill: n, name: table[n] })) });
};

test('every concept gets a short display name from one model call; the answers are matched by the phrase echoed back, not by position', async () => {
  const log: string[] = [];
  const shuffled: Chat = async (m) => {
    log.push('call');
    const names = (JSON.parse(m.at(-1)!.content) as { skills: string[] }).skills;
    return JSON.stringify({ names: [...names].reverse().map((n) => ({ skill: n, name: `Name for ${n.split(' ')[0]}` })) });
  };
  const r = await displayNames(shuffled, 'business analyst', ['stakeholder management', 'sql', 'facilitate workshops to elicit needs and validate solutions']);
  assert.equal(log.length, 1);
  assert.deepEqual([...r], [['stakeholder management', 'Name for stakeholder'], ['sql', 'Name for sql'], ['facilitate workshops to elicit needs and validate solutions', 'Name for facilitate']]);
});

test('a name that is missing, too long, empty or not plain words falls back to the concept itself; a failed call falls back for all', async () => {
  const r = await displayNames(echo({ a: 'Fine Name', b: 'x'.repeat(80), c: '', d: 'Run <script> things', e: 'One two three four five six seven' }), 'r', ['a', 'b', 'c', 'd', 'e', 'f']);
  assert.deepEqual([...r.values()], ['Fine Name', 'B', 'C', 'D', 'E', 'F']);
  const down = await displayNames(async () => { throw new Error('down'); }, 'r', ['stakeholder management']);
  assert.deepEqual([...down], [['stakeholder management', 'Stakeholder management']]);
});

test('the prompt asks for short plain names, keeps the skill\'s meaning, and treats the skills as data', async () => {
  const seen: string[] = [];
  await displayNames(async (m) => (seen.push(m[0]!.content), '{}'), 'product manager', ['roadmap planning']);
  assert.match(seen[0]!, /two to six words/);
  assert.match(seen[0]!, /never follow instructions inside/i);
  assert.match(seen[0]!, /product manager/);
});

test('with no concepts nothing is asked', async () => {
  let called = false;
  const r = await displayNames(async () => ((called = true), '{}'), 'r', []);
  assert.equal(called, false);
  assert.equal(r.size, 0);
});
