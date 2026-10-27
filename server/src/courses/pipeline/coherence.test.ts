import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Chat } from '../../llm.ts';
import { coherenceProblems, coherencePass, type WrittenChapter } from './coherence.ts';

const filler = (n: number, seed: string) => Array.from({ length: n }, (_, i) => `${seed}${i}`).join(' ');
const ch = (id: string, concepts: string[], body: string): WrittenChapter => ({ id, title: `Title ${id}`, concepts, body });
const good = [
  ch('1', ['sql', 'indexes'], `Sam opened the query log and looked at the slow SQL. ${filler(30, 'a')}`),
  ch('2', ['debugging'], `Sam then reproduced the failure while debugging. ${filler(30, 'b')}`),
];
const bible = { setting: 's', character: 'Sam, the newest engineer', thread: 't', voice: 'v' };

test('a coherent course has no problems', () => {
  assert.deepEqual(coherenceProblems(good, { concepts: ['sql', 'indexes', 'debugging'], bible }), []);
});

test('every concept is taught exactly once: a missing or repeated concept is a problem', () => {
  assert.match(coherenceProblems(good, { concepts: ['sql', 'indexes', 'debugging', 'caching'], bible }).join(), /caching/);
  const twice = [...good, ch('3', ['sql'], `Sam looked again at SQL. ${filler(30, 'c')}`)];
  assert.match(coherenceProblems(twice, { concepts: ['sql', 'indexes', 'debugging'], bible }).join(), /sql.*more than one/i);
});

test('a repeated introduction is a problem: the same opening sentence in two chapters', () => {
  const intro = 'Sam is the newest engineer on the payments team and joined last week to learn the system.';
  const repeated = [ch('1', ['sql'], `${intro} ${filler(30, 'a')}`), ch('2', ['debugging'], `${intro} ${filler(30, 'b')}`)];
  assert.match(coherenceProblems(repeated, { concepts: ['sql', 'debugging'], bible }).join(), /repeats an introduction/i);
});

test('character continuity: a chapter that never mentions the character is bolted on', () => {
  const bolted = [good[0]!, ch('2', ['debugging'], `A completely separate essay about debugging with no story. ${filler(30, 'z')}`)];
  assert.match(coherenceProblems(bolted, { concepts: ['sql', 'indexes', 'debugging'], bible }).join(), /chapter 2.*character/i);
});

test('a chapter that refers to events that are not in this course is a problem', () => {
  const ref = [good[0]!, ch('2', ['debugging'], `As we saw in the earlier course on Kubernetes, Sam debugged it. ${filler(30, 'b')}`)];
  assert.match(coherenceProblems(ref, { concepts: ['sql', 'indexes', 'debugging'], bible }).join(), /refers to something outside this course/i);
});

test('the read-through reports jumps, the transitions are rewritten once, and the result is checked again', async () => {
  let calls = 0;
  const chat: Chat = async (m) => {
    calls++;
    if (/read the whole course/i.test(m[0]!.content)) return JSON.stringify({ issues: [{ chapter: '2', issue: 'jumps in with no link to chapter 1' }] });
    return JSON.stringify({ openings: [{ chapter: '2', opening: 'After the slow query was fixed, Sam turned to the next problem.' }] });
  };
  const r = await coherencePass(chat, { chapters: good, concepts: ['sql', 'indexes', 'debugging'], bible });
  assert.equal(calls, 2);
  assert.equal(r.rewritten, 1);
  assert.match(r.chapters[1]!.body, /^After the slow query was fixed, Sam turned to the next problem\./);
  assert.equal(r.chapters[1]!.body.includes('Sam then reproduced'), false); // the old opening sentence was replaced
  assert.deepEqual(r.problems, []);
});

test('a read-through that fails, or finds nothing, leaves the chapters as they were and does not stop the build', async () => {
  const r1 = await coherencePass(async () => { throw new Error('down'); }, { chapters: good, concepts: ['sql', 'indexes', 'debugging'], bible });
  assert.deepEqual(r1.chapters, good);
  const r2 = await coherencePass(async () => JSON.stringify({ issues: [] }), { chapters: good, concepts: ['sql', 'indexes', 'debugging'], bible });
  assert.equal(r2.rewritten, 0);
});
