import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Chat } from '../../llm.ts';
import { makeSectionQuiz } from './sectionQuiz.ts';

const questions = [
  { prompt: 'What does a query plan show?', options: ['How the database runs a query', 'Who wrote the query', 'The price of a query', 'When the query was first made'], correct_index: 0 },
  { prompt: 'What should you do before changing a failing system?', options: ['Reproduce the failure first', 'Restart every server at once', 'Delete the logs for space', 'Ask for a new laptop today'], correct_index: 0 },
  { prompt: 'Why add an index to a column?', options: ['Reads on it get faster', 'The table becomes smaller', 'Writes no longer cost anything', 'Backups run twice as fast'], correct_index: 0 },
];
const text = 'A query plan shows how the database runs a query. Reproduce the failure first before changing a failing system. An index makes reads on the column faster.';

/** A model that writes the quiz when asked to, and answers the check with the given supported letters. */
function model(quiz: object | string, supported: string[][] | Error = [['A'], ['A'], ['A']]): Chat & { calls: string[] } {
  const calls: string[] = [];
  const chat = (async (m) => {
    calls.push(m[0]!.content.includes('You check a quiz') ? 'verify' : 'write');
    if (m[0]!.content.includes('You check a quiz')) {
      if (supported instanceof Error) throw supported;
      return JSON.stringify({ supported });
    }
    return typeof quiz === 'string' ? quiz : JSON.stringify({ topic: null, questions: quiz });
  }) as Chat & { calls: string[] };
  chat.calls = calls;
  return chat;
}

test('a section quiz is written and checked against the section text, and comes back as three validated questions', async () => {
  const chat = model(questions);
  const r = await makeSectionQuiz(chat, text);
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.questions.length, 3);
  assert.deepEqual(chat.calls, ['write', 'verify']);
});

test('a quiz the validation rejects is rewritten once with the reason; a second bad quiz is reported', async () => {
  const chat = model('not json');
  const r = await makeSectionQuiz(chat, text);
  assert.equal(r.ok, false);
  assert.equal(chat.calls.filter((c) => c === 'write').length, 2);
});

test('a quiz whose marked answer the text does not support is rewritten once, then reported', async () => {
  const chat = model(questions, [['B'], ['A'], ['A']]);
  const r = await makeSectionQuiz(chat, text);
  assert.equal(r.ok, false);
  assert.equal(chat.calls.filter((c) => c === 'verify').length, 2);
});

test('a checker that cannot be reached means the quiz is not verified, which is a failure and not a pass', async () => {
  assert.equal((await makeSectionQuiz(model(questions, new Error('down')), text)).ok, false);
});

test('a quiz whose model call fails says why: the underlying error is in the reason', async () => {
  const r = await makeSectionQuiz(async () => { throw new Error('reply was cut off at the token limit'); }, 'Sam reviews the deployment plan with the team.');
  assert.ok(!r.ok && /could not be reached.*cut off at the token limit/.test(r.reason));
});
