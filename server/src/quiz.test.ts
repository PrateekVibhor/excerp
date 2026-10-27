import assert from 'node:assert/strict';
import { test } from 'node:test';
import { INTERESTS } from '../../src/data/types.ts';
import type { Chat, ChatMessage } from './llm.ts';
import { buildQuizMessages, buildVerifyMessages, compareWithKey, findAnswerLeaks, findNearDuplicates, generateQuiz, MAX_LENGTH_RATIO, MAX_OPTION_CHARS, MAX_PROMPT_CHARS, MIN_LENGTH_GAP, NEAR_DUPLICATE_MIN_WORDS, NEAR_DUPLICATE_ORDER_SIMILARITY, NEAR_DUPLICATE_SIMILARITY, parseQuiz, parseSupported, quizSystemPrompt, validateQuiz, verifyQuiz, verifySystemPrompt, wordOrderSimilarity, wordOverlap, wordsOf } from './quiz.ts';

const question = (n: number) => ({
  prompt: `What does key point ${n} say?`,
  options: [`Right answer ${n}`, `Wrong answer ${n}a`, `Wrong answer ${n}b`, `Wrong answer ${n}c`],
  correct_index: n % 4,
});
const valid = () => ({ questions: [question(1), question(2), question(3)], topic: 'Agents' });
/** A valid quiz with one change made to it. */
const changed = (edit: (q: ReturnType<typeof valid>) => void) => {
  const q = valid();
  edit(q);
  return q;
};
const reason = (raw: unknown) => {
  const result = validateQuiz(raw);
  assert.equal(result.ok, false, 'should have been rejected');
  return result.ok ? '' : result.reason;
};

test('Scenario: Validation - a valid quiz is accepted and comes back as it was sent', () => {
  const result = validateQuiz(valid());
  assert.deepEqual(result, { ok: true, value: { quiz: { questions: [question(1), question(2), question(3)] }, topic: 'Agents' } });
});

test('every correct_index from 0 to 3 is accepted', () => {
  for (const index of [0, 1, 2, 3]) {
    assert.equal(validateQuiz(changed((q) => (q.questions[0].correct_index = index))).ok, true);
  }
});

test('Scenario: Validation - the wrong number of questions is rejected', () => {
  assert.match(reason(changed((q) => q.questions.pop())), /exactly 3 questions/); // 2
  assert.match(reason(changed((q) => q.questions.push(question(4)))), /exactly 3 questions/); // 4
  assert.match(reason({ questions: [], topic: 'Agents' }), /exactly 3 questions/);
  assert.match(reason({ topic: 'Agents' }), /exactly 3 questions/);
  assert.match(reason({ questions: 'three', topic: 'Agents' }), /exactly 3 questions/);
});

test('Scenario: Validation - a question with 3 or 5 options is rejected, and says which question', () => {
  assert.match(reason(changed((q) => q.questions[1].options.pop())), /question 2 must have exactly 4 options/);
  assert.match(reason(changed((q) => q.questions[2].options.push('A fifth'))), /question 3 must have exactly 4 options/);
  assert.match(reason(changed((q) => ((q.questions[0] as { options: unknown }).options = 'a, b, c, d'))), /question 1 must have exactly 4 options/);
  // not lists, but each has a length of 4: must be rejected, not crash
  for (const notAList of ['abcd', { length: 4 }]) {
    assert.match(reason(changed((q) => ((q.questions[0] as { options: unknown }).options = notAList))), /question 1 must have exactly 4 options/);
  }
  assert.match(reason(changed((q) => ((q.questions[0] as { options: unknown }).options = null))), /question 1 must have exactly 4 options/);
});

test('Scenario: Validation - a correct_index outside 0 to 3, or not a whole number, is rejected', () => {
  for (const bad of [4, -1, 1.5, '2', null, Number.NaN]) {
    assert.match(reason(changed((q) => ((q.questions[0] as { correct_index: unknown }).correct_index = bad))), /correct_index must be a whole number from 0 to 3/, String(bad));
  }
  assert.match(reason(changed((q) => delete (q.questions[2] as { correct_index?: number }).correct_index)), /question 3 correct_index/);
});

test('Scenario: Duplicate options - two identical options are rejected, also when only case or spacing differs', () => {
  assert.match(reason(changed((q) => (q.questions[1].options[3] = q.questions[1].options[0]))), /question 2 has two identical options/);
  assert.match(reason(changed((q) => (q.questions[0].options[1] = ` ${q.questions[0].options[0].toUpperCase()}  `))), /question 1 has two identical options/);
  assert.match(reason(changed((q) => (q.questions[0].options = ['same', 'same', 'same', 'same']))), /identical/);
});

// ---- length of the right answer ---------------------------------------------------------------

/** A quiz whose question `q` (0-based) has a right option of `right` characters and wrong options of the given lengths. */
function withLengths(right: number, wrong: [number, number, number], q = 0, correctIndex = 1) {
  return changed((quiz) => {
    const filler = (len: number, tag: string) => (tag + 'x'.repeat(len)).slice(0, len);
    const wrongs = wrong.map((len, i) => filler(len, `w${i}`));
    const options = [...wrongs];
    options.splice(correctIndex, 0, filler(right, 'RIGHT'));
    quiz.questions[q].options = options;
    quiz.questions[q].correct_index = correctIndex;
  });
}

test('the limits are 1.5 times and 8 characters', () => {
  assert.equal(MAX_LENGTH_RATIO, 1.5);
  assert.equal(MIN_LENGTH_GAP, 8);
});

test('Scenario: Right answer much longer - a right option more than 1.5 times the longest wrong one is rejected', () => {
  assert.match(reason(withLengths(31, [20, 12, 10])), /question 1 has a right answer of 31 characters but no wrong answer longer than 20; make the four options about the same length/);
  assert.match(reason(withLengths(70, [20, 20, 20], 2)), /question 3 has a right answer of 70 characters but no wrong answer longer than 20/);
});

test('exactly 1.5 times the longest wrong option is allowed, one character more is not', () => {
  assert.equal(validateQuiz(withLengths(30, [20, 12, 10])).ok, true);
  assert.equal(validateQuiz(withLengths(31, [20, 12, 10])).ok, false);
  assert.equal(validateQuiz(withLengths(60, [40, 12, 10])).ok, true);
  assert.equal(validateQuiz(withLengths(61, [40, 12, 10])).ok, false);
});

test('it is the longest wrong option that counts, not their average', () => {
  assert.equal(validateQuiz(withLengths(40, [5, 5, 29])).ok, true); // 40 is under 1.5 x 29, though far over the average
  assert.equal(validateQuiz(withLengths(40, [5, 5, 26])).ok, false); // 40 is over 1.5 x 26
});

test('a short answer is not a giveaway: the gap must be at least 8 characters too', () => {
  assert.equal(validateQuiz(withLengths(13, [6, 5, 5])).ok, true); // 2.2 times as long, but only 7 characters more
  assert.equal(validateQuiz(withLengths(14, [6, 5, 5])).ok, false); // 8 characters more
  assert.equal(validateQuiz(withLengths(7, [3, 3, 2])).ok, true);
});

test('a right answer that is the same length, shorter, or the shortest is fine', () => {
  assert.equal(validateQuiz(withLengths(20, [20, 20, 20])).ok, true);
  assert.equal(validateQuiz(withLengths(10, [40, 40, 40])).ok, true);
  assert.equal(validateQuiz(withLengths(25, [20, 30, 40])).ok, true);
});

test('the right answer is checked wherever it sits among the options', () => {
  for (const position of [0, 1, 2, 3]) {
    assert.equal(validateQuiz(withLengths(50, [20, 20, 20], 0, position)).ok, false, `position ${position}`);
    assert.equal(validateQuiz(withLengths(28, [20, 20, 20], 0, position)).ok, true, `position ${position}`);
  }
});

test('lengths count after trimming and collapsing spaces', () => {
  const padded = changed((q) => {
    q.questions[0].options = ['   ' + 'a'.repeat(20) + '   ', 'b'.repeat(20), 'c'.repeat(20), 'd'.repeat(30)];
    q.questions[0].correct_index = 3;
  });
  assert.equal(validateQuiz(padded).ok, true); // 30 is exactly 1.5 x 20
  const spaced = changed((q) => {
    q.questions[0].options = ['a'.repeat(20), 'b'.repeat(20), 'c'.repeat(20), 'd'.repeat(20) + '          x'];
    q.questions[0].correct_index = 3;
  });
  assert.equal(validateQuiz(spaced).ok, true); // 22 once the spaces collapse
});

test('the first problem is still reported first: a duplicate comes before a length problem', () => {
  const q = withLengths(60, [20, 20, 20]);
  q.questions[0].options[0] = q.questions[0].options[2];
  assert.match(reason(q), /identical/);
});

test('the model is told about it and tries again, like any other rule', async () => {
  const tooLong = JSON.stringify(withLengths(60, [20, 20, 20], 1));
  const fine = JSON.stringify(valid());
  const calls: ChatMessage[][] = [];
  const replies = [tooLong, fine];
  const chat: Chat = async (messages) => {
    calls.push(messages.map((m) => ({ ...m })));
    return replies[calls.length - 1];
  };
  const logged: Array<{ attempt: number; reason: string }> = [];
  const result = await generateQuiz(SUMMARY, chat, { sleep: async () => {}, verify: false, log: (e) => logged.push(e) });
  assert.equal(result.ok, true);
  assert.equal(result.attempts, 2);
  assert.equal(logged.length, 1);
  assert.match(logged[0].reason, /question 2 has a right answer of 60 characters but no wrong answer longer than 20/);
  assert.match(calls[1].at(-1)?.content ?? '', /That was not usable: question 2 has a right answer of 60 characters/);
  assert.equal(calls[1].at(-2)?.content, tooLong);
});

test('the prompt asks for options of similar length', () => {
  assert.match(quizSystemPrompt(), /about the same length and level of detail/);
});

test('the same option text in two different questions is fine', () => {
  const q = valid();
  q.questions[1].options[0] = q.questions[0].options[0];
  assert.equal(validateQuiz(q).ok, true);
});

test('a topic outside the 8 interest topics becomes null and does not reject the quiz', () => {
  for (const topic of ['Cooking', 'Other', '', null, 42, undefined]) {
    const result = validateQuiz({ ...valid(), topic });
    assert.equal(result.ok, true, String(topic));
    assert.equal(result.ok && result.value.topic, null, String(topic));
    assert.equal(result.ok && result.value.quiz.questions.length, 3);
  }
});

test('each of the 8 interest topics is accepted, whatever its case or spacing', () => {
  assert.equal(INTERESTS.length, 8);
  for (const topic of INTERESTS) {
    assert.equal((validateQuiz({ ...valid(), topic }) as { value: { topic: string } }).value.topic, topic);
    assert.equal((validateQuiz({ ...valid(), topic: `  ${topic.toUpperCase()} ` }) as { value: { topic: string } }).value.topic, topic);
  }
});

test('Scenario: Validation - an empty or blank prompt is rejected', () => {
  for (const prompt of ['', '   \n ', undefined, null, 7]) {
    assert.match(reason(changed((q) => ((q.questions[1] as { prompt: unknown }).prompt = prompt))), /question 2 has no prompt/, String(prompt));
  }
});

test('a prompt that mentions "the summary" or "according to" is rejected, in any case, and says which question', () => {
  for (const prompt of ['What exam can AI pass according to the summary?', 'Which firms, ACCORDING TO the data, lead?', 'What does The Summary say about cost?', 'According to BCG, what share of firms benefit?', 'In the summary, who must judge output?']) {
    assert.match(reason(changed((q) => (q.questions[1].prompt = prompt))), /question 2 prompt must not mention "the summary" or "according to"/, prompt);
  }
});

test('prompts that only use similar words are accepted', () => {
  for (const prompt of ['Which summary statistic rose?', 'What is a summary judgment?', 'Who accorded the award?', 'What was the summarized result?', 'Which lathe summary figure rose?']) {
    assert.equal(validateQuiz(changed((q) => (q.questions[0].prompt = prompt))).ok, true, prompt);
  }
});

test('only prompts are checked for those phrases, not options', () => {
  assert.equal(validateQuiz(changed((q) => (q.questions[0].options[0] = 'According to the summary'))).ok, true); // a wrong option; the right one sits at index 1
});

test('a prompt of 140 characters is accepted and one of 141 is rejected', () => {
  assert.equal(validateQuiz(changed((q) => (q.questions[0].prompt = 'p'.repeat(MAX_PROMPT_CHARS)))).ok, true);
  assert.match(reason(changed((q) => (q.questions[0].prompt = 'p'.repeat(MAX_PROMPT_CHARS + 1)))), /question 1 prompt has 141 characters; the limit is 140/);
});

test('an option of 80 characters is accepted and one of 81 is rejected', () => {
  assert.equal(validateQuiz(changed((q) => (q.questions[0].options[2] = 'o'.repeat(MAX_OPTION_CHARS)))).ok, true);
  assert.match(reason(changed((q) => (q.questions[2].options[3] = 'o'.repeat(MAX_OPTION_CHARS + 1)))), /question 3 has an option of 81 characters; the limit is 80/);
});

test('an empty, blank or non-text option is rejected', () => {
  for (const option of ['', '   ', null, 5]) {
    assert.match(reason(changed((q) => ((q.questions[0].options as unknown[])[2] = option))), /question 1 has an empty option/, String(option));
  }
});

test('lengths are counted after trimming and collapsing spaces', () => {
  const padded = changed((q) => {
    q.questions[0].prompt = `  ${'p'.repeat(MAX_PROMPT_CHARS)}  `;
    q.questions[0].options[0] = `${'o'.repeat(MAX_OPTION_CHARS)}   `;
    q.questions[1].prompt = 'two   words\nhere';
  });
  const result = validateQuiz(padded);
  assert.equal(result.ok, true);
  assert.equal(result.ok && result.value.quiz.questions[0].prompt.length, MAX_PROMPT_CHARS);
  assert.equal(result.ok && result.value.quiz.questions[1].prompt, 'two words here');
});

test('a question that is not an object, or a reply that is not an object, is rejected', () => {
  assert.match(reason(changed((q) => ((q.questions as unknown[])[1] = 'what?'))), /question 2 is not an object/);
  assert.match(reason(changed((q) => ((q.questions as unknown[])[0] = null))), /question 1 is not an object/);
  assert.match(reason(changed((q) => ((q.questions as unknown[])[2] = [1, 2]))), /question 3 is not an object/);
  for (const raw of [null, 'quiz', 3, [valid()], undefined]) assert.match(reason(raw), /not a JSON object/);
});

test('the first problem found is the one reported, in question order', () => {
  const q = valid();
  q.questions[2].options.pop();
  q.questions[1].prompt = '';
  assert.match(reason(q), /question 2 has no prompt/);
});

test('Scenario: Validation - malformed JSON is rejected without throwing', () => {
  for (const text of ['', 'not json at all', '{"questions": [', '{"questions": [1, 2,]}', '```json\n{oops}\n```', '} {', '<think>{"a":1}</think> no object']) {
    const result = parseQuiz(text);
    assert.equal(result.ok, false, text);
    assert.match(result.ok ? '' : result.reason, /no JSON object|not valid JSON/, text);
  }
});

test('parseQuiz reads a valid reply wrapped in thinking, a code fence and chatter', () => {
  const json = JSON.stringify(valid());
  for (const text of [json, `<think>Let me pick points.</think>\n${json}`, `Here is the quiz:\n\`\`\`json\n${json}\n\`\`\`\nHope it helps!`]) {
    const result = parseQuiz(text);
    assert.equal(result.ok, true);
    assert.equal(result.ok && result.value.topic, 'Agents');
  }
});

test('parseQuiz passes validation failures on, with the same reasons', () => {
  const result = parseQuiz(JSON.stringify(changed((q) => q.questions.pop())));
  assert.equal(result.ok, false);
  assert.match(result.ok ? '' : result.reason, /exactly 3 questions/);
});

// ---- generation -----------------------------------------------------------------------------

const SUMMARY = 'A team describes a runtime control layer for AI agents. It checks each tool call against policy before it runs, and logs every decision.';
const goodReply = JSON.stringify(valid());

/** A fake model that answers from a script and records what it was sent. */
function scripted(...replies: Array<string | Error>) {
  const calls: ChatMessage[][] = [];
  const chat: Chat = async (messages) => {
    calls.push(messages.map((m) => ({ ...m })));
    const next = replies[Math.min(calls.length - 1, replies.length - 1)];
    if (next instanceof Error) throw next;
    return next;
  };
  return { chat, calls };
}
const noWait = { sleep: async () => {}, verify: false };

test('the prompt asks for 3 questions on different key points, 4 options with one correct, a topic from the 8, and only the summary', () => {
  const prompt = quizSystemPrompt();
  for (const topic of INTERESTS) assert.ok(prompt.includes(`"${topic}"`), topic);
  assert.match(prompt, /exactly 3 questions, one for each of three different key points/);
  assert.match(prompt, /exactly 4 different options and exactly one is correct/);
  assert.match(prompt, /right answer and the point of every question must come from it/);
  assert.match(prompt, /Never write "the summary", "the text", "the article" or "according to"/);
  assert.match(prompt, /different part of the text, and no question may give away or reuse the answer to another/);
  assert.match(prompt, /plausible and of the same kind as the right one/);
  assert.match(prompt, /not build the options of different questions from the same few figures/);
  assert.match(prompt, /four options of a question about the same length and level of detail/);
  assert.match(prompt, /cannot be spotted by being longer or more complete/);
  assert.match(prompt, /under 140 characters/);
  assert.match(prompt, /under 80/);
  assert.match(prompt, /correct_index/);
});

test('the model is sent the summary and nothing else about the article', () => {
  const messages = buildQuizMessages(`  ${SUMMARY}\n`);
  assert.deepEqual(messages.map((m) => m.role), ['system', 'user']);
  assert.equal(messages[1].content, `SUMMARY:\n${SUMMARY}`);
});

test('a good reply is returned on the first attempt, with no failures', async () => {
  const { chat, calls } = scripted(goodReply);
  const result = await generateQuiz(SUMMARY, chat, noWait);
  assert.equal(result.ok, true);
  assert.equal(result.attempts, 1);
  assert.deepEqual(result.failures, []);
  assert.equal(result.ok && result.value.topic, 'Agents');
  assert.equal(calls.length, 1);
});

test('a bad reply is retried, the model is told why, and every failed attempt is logged with its reason', async () => {
  const twoQuestions = JSON.stringify(changed((q) => q.questions.pop()));
  const { chat, calls } = scripted(twoQuestions, 'sorry, no JSON here', goodReply);
  const logged: unknown[] = [];
  const result = await generateQuiz(SUMMARY, chat, { ...noWait, log: (e) => logged.push(e) });
  assert.equal(result.ok, true);
  assert.equal(result.attempts, 3);
  assert.equal(result.failures.length, 2);
  assert.deepEqual(logged, [
    { event: 'quiz_attempt_failed', attempt: 1, reason: 'quiz must have exactly 3 questions' },
    { event: 'quiz_attempt_failed', attempt: 2, reason: 'reply contains no JSON object' },
  ]);
  // the second call carries the first reply and the reason
  assert.equal(calls[1].at(-2)?.content, twoQuestions);
  assert.match(calls[1].at(-1)?.content ?? '', /That was not usable: quiz must have exactly 3 questions/);
});

test('a failed model call is retried and logged too', async () => {
  const { chat } = scripted(new Error('Token Factory answered HTTP 503'), goodReply);
  const logged: Array<{ reason: string }> = [];
  const result = await generateQuiz(SUMMARY, chat, { ...noWait, log: (e) => logged.push(e) });
  assert.equal(result.ok, true);
  assert.deepEqual(logged.map((e) => e.reason), ['model call failed: Token Factory answered HTTP 503']);
});

test('after the last attempt it gives up without throwing, with one reason per attempt', async () => {
  const { chat, calls } = scripted('nope');
  const logged: unknown[] = [];
  const result = await generateQuiz(SUMMARY, chat, { ...noWait, log: (e) => logged.push(e) });
  assert.equal(result.ok, false);
  assert.equal(result.attempts, 3); // the first try and 2 retries
  assert.equal(calls.length, 3);
  assert.equal(result.failures.length, 3);
  assert.equal(logged.length, 3);
  assert.equal(!result.ok && result.reason, 'reply contains no JSON object');
});

test('retries can be set, and waits grow between attempts', async () => {
  const { chat, calls } = scripted('nope');
  assert.equal((await generateQuiz(SUMMARY, chat, { ...noWait, retries: 0 })).attempts, 1);
  assert.equal(calls.length, 1);
  const waits: number[] = [];
  await generateQuiz(SUMMARY, scripted('nope').chat, { retries: 2, retryDelayMs: 500, sleep: async (ms) => void waits.push(ms) });
  assert.deepEqual(waits, [500, 1000]);
});

// ---- the self-check: the model answers the quiz from the summary alone --------------------------------

const QUIZ = validateQuiz(valid()) as { ok: true; value: { quiz: import('../../src/data/types.ts').Quiz } };
const quiz = QUIZ.value.quiz;
// valid() marks B, then D, then A (correct_index 1, 2, 3 mod 4 -> n % 4 for n = 1, 2, 3)
const MARKED = quiz.questions.map((q) => q.correct_index);
const letter = (i: number) => 'ABCD'[i];
const agrees = JSON.stringify({ supported: MARKED.map((i) => [letter(i)]) });
const supports = (...perQuestion: string[][]) => JSON.stringify({ supported: perQuestion });

test('the checker is shown the summary and the lettered questions, and not the answer key', () => {
  const [system, user] = buildVerifyMessages(SUMMARY, quiz);
  assert.equal(system.role, 'system');
  assert.equal(system.content, verifySystemPrompt());
  assert.equal(user.role, 'user');
  assert.ok(user.content.startsWith(`SUMMARY:\n${SUMMARY}\n\nQUESTIONS:\n1. ${quiz.questions[0].prompt}\n   A) ${quiz.questions[0].options[0]}`));
  for (const q of quiz.questions) for (const [i, o] of q.options.entries()) assert.ok(user.content.includes(`   ${letter(i)}) ${o}`));
  // nothing but the summary, the prompts and the options is in the message: the key (correct_index) cannot be in it
  const expected = `SUMMARY:\n${SUMMARY}\n\nQUESTIONS:\n` + quiz.questions.map((q, i) => [`${i + 1}. ${q.prompt}`, ...q.options.map((o, k) => `   ${letter(k)}) ${o}`)].join('\n')).join('\n\n');
  assert.equal(user.content, expected);
  assert.ok(!user.content.includes('correct_index'));
});

test('the checker prompt asks for every supported option, from the summary only, as letters', () => {
  const prompt = verifySystemPrompt();
  assert.match(prompt, /every option that the SUMMARY clearly supports/);
  assert.match(prompt, /Do not use outside knowledge/);
  assert.match(prompt, /one supported option, several, or none/);
  assert.match(prompt, /\{"supported": \[\["B"\], \["A", "C"\], \["D"\]\]\}/);
});

test('parseSupported reads letters in any case, drops repeats, and accepts empty and multiple answers', () => {
  assert.deepEqual(parseSupported(supports(['B'], ['a', 'c'], [])), [[1], [0, 2], []]);
  assert.deepEqual(parseSupported(supports(['D', 'D', ' b '], ['A'], ['C'])), [[1, 3], [0], [2]]);
  assert.deepEqual(parseSupported('<think>hmm</think>\n```json\n' + supports(['A'], ['B'], ['C']) + '\n```'), [[0], [1], [2]]);
});

test('parseSupported refuses anything that is not three lists of letters A to D', () => {
  assert.throws(() => parseSupported('no json'), /no JSON object/);
  assert.throws(() => parseSupported('{"answers": [["A"]]}'), /must list 3 answers/);
  assert.throws(() => parseSupported(supports(['A'], ['B'])), /must list 3 answers/);
  assert.throws(() => parseSupported(supports(['A'], ['B'], ['C'], ['D'])), /must list 3 answers/);
  assert.throws(() => parseSupported('{"supported": ["A", "B", "C"]}'), /question 1 is not a list/);
  assert.throws(() => parseSupported(supports(['A'], ['E'], ['C'])), /question 2 has a letter that is not A to D/);
  assert.throws(() => parseSupported('{"supported": [["A"], ["B"], [1]]}'), /question 3 has a letter/);
});

test('compareWithKey accepts exactly one supported option that is the marked one, for every question', () => {
  assert.deepEqual(compareWithKey(quiz, MARKED.map((i) => [i])), { ok: true });
});

test('Scenario: Wrong key - the summary supports a different option than the one marked', () => {
  const found = MARKED.map((i) => [i]);
  found[1] = [(MARKED[1] + 1) % 4];
  const result = compareWithKey(quiz, found);
  assert.equal(result.ok, false);
  assert.equal(!result.ok && result.reason, `question 2: the summary supports ${letter(found[1][0])}, but ${letter(MARKED[1])} is marked right`);
});

test('Scenario: More than one right answer - the marked option and another are both supported', () => {
  const found = MARKED.map((i) => [i]);
  found[2] = [MARKED[2], (MARKED[2] + 2) % 4].sort();
  const result = compareWithKey(quiz, found);
  assert.equal(!result.ok && result.reason, `question 3: the summary supports ${found[2].map(letter).join(' and ')}, but only ${letter(MARKED[2])} is marked right; make exactly one option correct`);
});

test('two supported options that are both not the marked one is a wrong key, not a double answer', () => {
  const found = MARKED.map((i) => [i]);
  found[0] = [(MARKED[0] + 1) % 4, (MARKED[0] + 2) % 4].sort();
  assert.match(!compareWithKey(quiz, found).ok ? (compareWithKey(quiz, found) as { reason: string }).reason : '', /supports .* and .*, but .* is marked right$/);
  assert.doesNotMatch((compareWithKey(quiz, found) as { reason: string }).reason, /make exactly one/);
});

test('Scenario: Unsupported question - nothing in the summary backs any option', () => {
  const found = MARKED.map((i) => [i]);
  found[0] = [];
  const result = compareWithKey(quiz, found);
  assert.equal(!result.ok && result.reason, `question 1: the summary does not support any option, and ${letter(MARKED[0])} is marked right; ask about something the summary says`);
});

test('the first disagreeing question is the one reported', () => {
  const found = MARKED.map((i) => [(i + 1) % 4]);
  assert.match((compareWithKey(quiz, found) as { reason: string }).reason, /^question 1:/);
});

test('verifyQuiz sends the checking messages and accepts a reply that agrees', async () => {
  const { chat, calls } = scripted(agrees);
  assert.deepEqual(await verifyQuiz(SUMMARY, quiz, chat), { ok: true });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], buildVerifyMessages(SUMMARY, quiz));
});

test('verifyQuiz turns a disagreement, an unreadable reply and a failed call into a reason, and never throws', async () => {
  const disagree = await verifyQuiz(SUMMARY, quiz, scripted(supports(['A'], ['A'], ['A'])).chat);
  assert.equal(disagree.ok, false);
  const garbage = await verifyQuiz(SUMMARY, quiz, scripted('I think they are all fine').chat);
  assert.deepEqual(garbage, { ok: false, reason: 'quiz check failed: reply contains no JSON object' });
  const down = await verifyQuiz(SUMMARY, quiz, scripted(new Error('Token Factory answered HTTP 503')).chat);
  assert.deepEqual(down, { ok: false, reason: 'quiz check failed: Token Factory answered HTTP 503' });
});

test('Scenario: the check runs by default - a good quiz takes two calls, the second to check it', async () => {
  const { chat, calls } = scripted(goodReply, agrees);
  const result = await generateQuiz(SUMMARY, chat, { sleep: async () => {} });
  assert.equal(result.ok, true);
  assert.equal(result.attempts, 1);
  assert.equal(calls.length, 2);
  assert.equal(calls[1][0].content, verifySystemPrompt());
});

test('a quiz the checker disagrees with is thrown back with the reason, logged, and replaced by a better one', async () => {
  const wrongKey = supports(['A'], [letter(MARKED[1])], [letter(MARKED[2])]);
  const { chat, calls } = scripted(goodReply, wrongKey, goodReply, agrees);
  const logged: Array<{ attempt: number; reason: string }> = [];
  const result = await generateQuiz(SUMMARY, chat, { sleep: async () => {}, log: (e) => logged.push(e) });
  assert.equal(result.ok, true);
  assert.equal(result.attempts, 2);
  assert.equal(calls.length, 4);
  assert.equal(logged.length, 1);
  assert.equal(logged[0].attempt, 1);
  assert.match(logged[0].reason, new RegExp(`^question 1: the summary supports A, but ${letter(MARKED[0])} is marked right`));
  // the generator is told, with its own reply in front of it, and is not given the checker's messages
  assert.equal(calls[2].at(-2)?.content, goodReply);
  assert.match(calls[2].at(-1)?.content ?? '', /That was not usable: question 1: the summary supports A/);
  assert.equal(calls[2][0].content, quizSystemPrompt());
});

test('a check that cannot be read counts as a failed attempt, not as a pass', async () => {
  const { chat } = scripted(goodReply, 'no idea', goodReply, agrees);
  const result = await generateQuiz(SUMMARY, chat, { sleep: async () => {} });
  assert.equal(result.ok, true);
  assert.equal(result.attempts, 2);
  assert.deepEqual(result.failures, ['quiz check failed: reply contains no JSON object']);
});

test('a quiz that never passes the check is not accepted: after all attempts there is no quiz', async () => {
  const wrong = supports(['A'], ['A'], ['A']);
  const calls: ChatMessage[][] = [];
  const chat: Chat = async (messages) => {
    calls.push(messages);
    return messages[0].content === verifySystemPrompt() ? wrong : goodReply; // quizzes come out fine, the checker disagrees every time
  };
  const logged: unknown[] = [];
  const result = await generateQuiz(SUMMARY, chat, { sleep: async () => {}, log: (e) => logged.push(e) });
  assert.equal(result.ok, false);
  assert.equal(result.attempts, 3);
  assert.equal(result.failures.length, 3);
  assert.equal(logged.length, 3);
  assert.equal(calls.length, 6); // a quiz and a check, three times
});

test('the check is skipped when the reply is not a valid quiz, so no tokens go on checking junk', async () => {
  const { chat, calls } = scripted('not json', 'not json', 'not json');
  const result = await generateQuiz(SUMMARY, chat, { sleep: async () => {} });
  assert.equal(result.ok, false);
  assert.equal(calls.length, 3); // no check calls
});

test('verify can be switched off, for tests', async () => {
  const { chat, calls } = scripted(goodReply);
  assert.equal((await generateQuiz(SUMMARY, chat, { sleep: async () => {}, verify: false })).ok, true);
  assert.equal(calls.length, 1);
});

// ---- rule: options that are the same words with one changed --------------------------------------------

/** A quiz whose first question has exactly these four options, the right one being the one at `right`. */
function withOptions(options: [string, string, string, string], right = 0, q = 0) {
  return changed((quiz) => {
    quiz.questions[q].options = [...options];
    quiz.questions[q].correct_index = right;
  });
}

test('the near-duplicate limits are 0.75 and 4 words', () => {
  assert.equal(NEAR_DUPLICATE_SIMILARITY, 0.75);
  assert.equal(NEAR_DUPLICATE_MIN_WORDS, 4);
});

test('wordsOf lower-cases, drops punctuation and keeps numbers and accents', () => {
  assert.deepEqual(wordsOf('Zhipu AI’s “Research” Division, 64-100%!'), ['zhipu', 'ai', 's', 'research', 'division', '64', '100']);
  assert.deepEqual(wordsOf('   '), []);
  assert.deepEqual(wordsOf('César de la Fuente'), ['césar', 'de', 'la', 'fuente']);
});

test('wordOverlap is shared words over all words: 1 for the same words, 0 for none, and ignores order and case', () => {
  assert.equal(wordOverlap('a b c d', 'D C B A'), 1);
  assert.equal(wordOverlap('a b c d', 'e f g h'), 0);
  assert.equal(wordOverlap('a b c d', 'a b c e'), 0.6);
  assert.equal(wordOverlap('a b c d e f', 'a b c d e f g h'), 0.75);
  assert.equal(wordOverlap('', 'a'), 0);
  assert.equal(wordOverlap('a a a b', 'a b'), 1); // a word counts once
});

test('Scenario: Near-duplicate options - the real case: one sentence with a word changed in each option', () => {
  const options: [string, string, string, string] = [
    'Target segments adopt AI-first models use outcome-based pricing transform talent',
    'Target markets adopt AI-first models use outcome-based pricing transform talent',
    'Target segments avoid AI-first models use outcome-based pricing transform talent',
    'Target segments adopt AI-first models use legacy pricing models transform talent',
  ];
  assert.deepEqual(findNearDuplicates(options), [[0, 1], [0, 2], [0, 3], [1, 2], [1, 3], [2, 3]].filter(([i, j]) => wordOverlap(options[i], options[j]) >= 0.75));
  assert.match(reason(withOptions(options)), /^question 1 has options A and B that are nearly the same words; make the four options clearly different$/);
});

test('exactly 0.75 shared words is rejected, a little less is not', () => {
  const six = 'alpha bravo charlie delta echo foxtrot';
  assert.equal(validateQuiz(withOptions([six, `${six} golf hotel`, 'one two three four five six', 'seven eight nine ten eleven twelve'])).ok, false); // 6 of 8
  assert.equal(validateQuiz(withOptions([six, `${six} golf hotel india`, 'one two three four five six', 'seven eight nine ten eleven twelve'])).ok, true); // 6 of 9
});

test('options of fewer than 4 words are not compared', () => {
  assert.equal(validateQuiz(withOptions(['alpha bravo charlie', 'alpha bravo charlie delta', 'one two three four', 'five six seven eight'])).ok, true); // 3 and 4 words, 0.75 shared
  assert.equal(validateQuiz(withOptions(['alpha bravo charlie delta', 'alpha bravo charlie delta echo', 'one two three four', 'five six seven eight'])).ok, false); // 4 and 5 words
});

test('lists that differ by one name are not near-duplicates: 4 of 6 words shared', () => {
  const lists: [string, string, string, string] = ['Acer, ASUS, Dell, HP, Lenovo', 'Acer, ASUS, Dell, HP, Samsung', 'Acer, ASUS, Dell, Lenovo, Microsoft', 'Acer, ASUS, Dell, HP, Apple'];
  assert.deepEqual(findNearDuplicates(lists), []);
  assert.equal(validateQuiz(withOptions(lists)).ok, true);
});

test('options that share a structure but not their words are fine', () => {
  assert.equal(validateQuiz(withOptions(['From years to hours', 'From months to weeks', 'From days to minutes', 'From decades to seconds'])).ok, true);
  assert.equal(validateQuiz(withOptions(['Approximately 70 percent of calls', 'Approximately 50 percent of calls', 'Approximately 90 percent of calls', 'Approximately 30 percent of calls'], 2)).ok, true);
});

test('case and punctuation do not hide a near-duplicate', () => {
  const r = reason(withOptions(['It reduces costs, saves time, and improves quality', 'it REDUCES costs; saves time and improves quality!', 'one two three four five', 'six seven eight nine ten']));
  assert.match(r, /options A and B/);
});

test('the pair reported is the first one, by position, whichever options are involved', () => {
  const base = 'alpha bravo charlie delta echo foxtrot';
  assert.match(reason(withOptions(['one two three four five', base, 'six seven eight nine ten', `${base} golf`], 1)), /options B and D/);
  assert.match(reason(withOptions([base, 'one two three four five', `${base} golf`, 'six seven eight nine ten'], 1)), /options A and C/);
});

test('it is checked in every question, and the right answer can be one of the pair', () => {
  const base = 'alpha bravo charlie delta echo foxtrot';
  const r = reason(withOptions([base, 'one two three four five', 'six seven eight nine ten', `${base} golf`], 3, 2));
  assert.match(r, /^question 3 has options A and D/);
});

test('an exact duplicate is still reported as identical, before the near-duplicate rule looks', () => {
  assert.match(reason(withOptions(['same same same same', 'same same same same', 'one two three four five', 'six seven eight nine ten'])), /identical/);
});

test('the model is told which options and tries again', async () => {
  const bad = JSON.stringify(withOptions(['alpha bravo charlie delta echo foxtrot', 'alpha bravo charlie delta echo foxtrot golf', 'one two three four five', 'six seven eight nine ten']));
  const calls: ChatMessage[][] = [];
  const replies = [bad, JSON.stringify(valid())];
  const chat: Chat = async (messages) => {
    calls.push(messages.map((m) => ({ ...m })));
    return replies[calls.length - 1];
  };
  const result = await generateQuiz(SUMMARY, chat, { sleep: async () => {}, verify: false });
  assert.equal(result.ok, true);
  assert.equal(result.attempts, 2);
  assert.match(calls[1].at(-1)?.content ?? '', /That was not usable: question 1 has options A and B that are nearly the same words/);
});

// ---- rule: a right answer that another question repeats ------------------------------------------------

/** A wrong option of about 60 characters made of words no other option uses, so the length and near-duplicate rules stay quiet. */
const filler = (q: number, k: number) => Array.from({ length: 8 }, (_, w) => `zz${q}${k}${'abcdefgh'[w]}x`).join(' ');

/** Three questions with the given prompts and right answers (the wrong options are filler that shares nothing). */
function threeQuestions(prompts: [string, string, string], rights: [string, string, string]) {
  return {
    questions: prompts.map((prompt, n) => ({
      prompt,
      options: [rights[n], filler(n, 1), filler(n, 2), filler(n, 3)],
      correct_index: 0,
    })),
    topic: 'Agents',
  };
}

test('Scenario: Answer leak in a right answer - the real case: question 2\'s answer sits inside question 1\'s right answer', () => {
  const quiz = threeQuestions(
    ['What did letting Claude choose problems produce?', 'What does the BootLoops toolkit provide?', 'What does this illustrate?'],
    ['The BootLoops toolkit for exact quantitative calculations', 'Exact quantitative calculations', 'Domain expertise stays essential'],
  );
  assert.deepEqual(findAnswerLeaks(quiz), [{ answer: 1, repeatedIn: 0, where: 'right answer', text: 'Exact quantitative calculations' }]);
  assert.equal(reason(quiz), 'question 1 answers with the right answer to question 2 ("Exact quantitative calculations"); make each question about a different point and do not reuse another question\'s answer');
});

test('Scenario: Answer leak in a prompt - the real case: question 2 asks with the answer to question 1', () => {
  const quiz = threeQuestions(
    ['What does generative AI make inexpensive?', 'When execution becomes cheap, what is the main source of value?', 'What must firms preserve?'],
    ['Execution', 'Verification of AI-generated output', 'Expertise and control of the model weights'],
  );
  assert.deepEqual(findAnswerLeaks(quiz), [{ answer: 0, repeatedIn: 1, where: 'prompt', text: 'Execution' }]);
  assert.equal(reason(quiz), 'question 2 asks with the right answer to question 1 ("Execution"); make each question about a different point and do not reuse another question\'s answer');
});

test('a quiz whose answers are different things has no leaks', () => {
  const quiz = threeQuestions(['What is the price?', 'Who builds it?', 'When does it ship?'], ['$899 starting price', 'Google and partners', 'October 4']);
  assert.deepEqual(findAnswerLeaks(quiz), []);
});

test('a short or number-only answer turning up again is not a leak', () => {
  const quiz = threeQuestions(['Share of calls resolved?', 'Which is 65% of what?', 'What is Muse?'], ['65%', 'Calls resolved by the agent', 'Muse']);
  assert.deepEqual(findAnswerLeaks(quiz), []); // "65%" is one short word, and "Muse" is four letters
  const names = threeQuestions(['Who is the Nobel laureate?', 'What did Philippe Aghion say?', 'What is studied?'], ['Philippe Aghion', 'That jobs matter most', 'Jobs and growth']);
  assert.equal(findAnswerLeaks(names).length, 1); // two real words repeated
});

test('a single word of five letters or more counts, a stop word on its own does not', () => {
  assert.equal(findAnswerLeaks(threeQuestions(['Name it?', 'Why does latency matter?', 'And?'], ['Latency', 'Because of speed', 'Other'])).length, 1);
  assert.equal(findAnswerLeaks(threeQuestions(['Which one?', 'Do both sides agree?', 'And?'], ['Both', 'Because of speed', 'Other'])).length, 0);
  assert.equal(findAnswerLeaks(threeQuestions(['Which one?', 'Is it the only way?', 'And?'], ['Only', 'Because of speed', 'Other'])).length, 0);
});

test('the words must appear together and in order', () => {
  const apart = threeQuestions(['What cuts cost?', 'Is exact work with quantitative tools the same as calculations?', 'And?'], ['Exact quantitative calculations', 'Because of speed', 'Other']);
  assert.deepEqual(findAnswerLeaks(apart), []); // all three words are there, but not as a phrase
  const reordered = threeQuestions(['What cuts cost?', 'Why do calculations quantitative exact matter?', 'And?'], ['Exact quantitative calculations', 'Because of speed', 'Other']);
  assert.deepEqual(findAnswerLeaks(reordered), []); // and not in another order
  const together = threeQuestions(['What cuts cost?', 'Why do exact quantitative calculations matter?', 'And?'], ['Exact quantitative calculations', 'Because of speed', 'Other']);
  assert.equal(findAnswerLeaks(together).length, 1);
});

test('a single word counts from five letters up: "Chips" is a leak, "Chip" is not', () => {
  assert.equal(findAnswerLeaks(threeQuestions(['Name it?', 'Why do Chips cost so much?', 'And?'], ['Chips', 'Because of demand', 'Other things'])).length, 1);
  assert.equal(findAnswerLeaks(threeQuestions(['Name it?', 'Why does a Chip cost so much?', 'And?'], ['Chip', 'Because of demand', 'Other things'])).length, 0);
});

test('answers made only of small words never count, however many there are', () => {
  assert.equal(findAnswerLeaks(threeQuestions(['Which is it?', 'What happens in the end?', 'And?'], ['In the', 'Because of demand', 'Other things'])).length, 0);
  assert.equal(findAnswerLeaks(threeQuestions(['Which is it?', 'Is it all of the above or none of it?', 'And?'], ['All of the', 'Because of demand', 'Other things'])).length, 0);
  // but one real word of five letters in the answer is enough, and the phrase must then match as a whole
  assert.equal(findAnswerLeaks(threeQuestions(['Which is it?', 'What happens in the cloud tonight?', 'And?'], ['In the cloud', 'Because of demand', 'Other things'])).length, 1);
  assert.equal(findAnswerLeaks(threeQuestions(['Which is it?', 'What happens in a cloud tonight?', 'And?'], ['In the cloud', 'Because of demand', 'Other things'])).length, 0);
});

test('case and punctuation do not hide a leak', () => {
  const quiz = threeQuestions(['What is it called?', 'Why did “EXACT, quantitative calculations!” matter?', 'And?'], ['exact quantitative calculations', 'Because of speed', 'Other']);
  assert.equal(findAnswerLeaks(quiz).length, 1);
});

test('wrong options that repeat another question\'s answer are not counted', () => {
  const quiz = threeQuestions(['What is the plan?', 'Who runs it?', 'When?'], ['Exact quantitative calculations', 'The research team', 'Next autumn']);
  quiz.questions[1].options[1] = 'Exact quantitative calculations done by hand';
  assert.deepEqual(findAnswerLeaks(quiz), []);
});

test('every question is checked against the others, in both directions, and the first leak is the one reported', () => {
  const quiz = threeQuestions(
    ['Who leads the quantum program?', 'What did the quantum program announce yesterday?', 'Which lab produced the quantum program?'],
    ['The quantum program', 'A new chip design', 'Bell Labs'],
  );
  // the right answer to question 1 is repeated in questions 2 and 3
  assert.deepEqual(findAnswerLeaks(quiz).map((l) => [l.answer, l.repeatedIn, l.where]), [[0, 1, 'prompt'], [0, 2, 'prompt']]);
  assert.match(reason(quiz), /^question 2 asks with the right answer to question 1/);
});

test('the leak rule runs after the single-question rules, which are reported first', () => {
  const quiz = threeQuestions(
    ['Name it?', 'What does Execution mean here?', 'Why?'],
    ['Execution', 'Doing the work', 'Because'],
  );
  quiz.questions[2].prompt = '';
  assert.match(reason(quiz), /question 3 has no prompt/);
});

test('the model is told about a leak and tries again', async () => {
  const leaky = JSON.stringify(threeQuestions(['A?', 'What about Execution costs?', 'C?'], ['Execution', 'Lower costs', 'Other things']));
  const calls: ChatMessage[][] = [];
  const replies = [leaky, JSON.stringify(valid())];
  const chat: Chat = async (messages) => {
    calls.push(messages.map((m) => ({ ...m })));
    return replies[calls.length - 1];
  };
  const result = await generateQuiz(SUMMARY, chat, { sleep: async () => {}, verify: false });
  assert.equal(result.ok, true);
  assert.equal(result.attempts, 2);
  assert.match(calls[1].at(-1)?.content ?? '', /That was not usable: question 2 asks with the right answer to question 1 \("Execution"\)/);
});

// ---- near-duplicates: the words must also sit in the same order --------------------------------------

const TWELVE = 'w01 w02 w03 w04 w05 w06 w07 w08 w09 w10 w11 w12';
const FILL: [string, string] = ['zz1 zz2 zz3 zz4 zz5 zz6', 'yy1 yy2 yy3 yy4 yy5 yy6'];

test('the order limit is 0.75', () => {
  assert.equal(NEAR_DUPLICATE_ORDER_SIMILARITY, 0.75);
});

test('wordOrderSimilarity counts the words to change, add or drop, over the longer option', () => {
  assert.equal(wordOrderSimilarity('a b c d', 'A, B, C, D!'), 1); // case and punctuation do not matter
  assert.equal(wordOrderSimilarity('a b c d', 'a b c x'), 0.75); // one word changed
  assert.equal(wordOrderSimilarity('a b c d', 'a b c d e'), 0.8); // one word added
  assert.equal(wordOrderSimilarity('a b c d e', 'a b d e'), 0.8); // one word dropped
  assert.equal(wordOrderSimilarity('a b c d', 'e f g h'), 0);
  assert.equal(wordOrderSimilarity('a b c d', 'd c b a'), 0); // the same words backwards: every position differs
  assert.equal(wordOrderSimilarity('', 'a'), 0);
  assert.equal(wordOrderSimilarity('', ''), 0);
});

test('Scenario: swapped parts - the same words in another order are different answers, not near-duplicates', () => {
  const swap: [string, string, string, string] = [
    'OpenShell runtime on Vera CPUs and Sentry on BlueField-4 DPUs',
    'OpenShell runtime on BlueField-4 DPUs and Sentry on Vera CPUs',
    'Only OpenShell runtime on Vera CPUs',
    'Only Sentry on BlueField-4 DPUs',
  ];
  assert.equal(wordOverlap(swap[0], swap[1]), 1); // the same words...
  assert.ok(wordOrderSimilarity(swap[0], swap[1]) < NEAR_DUPLICATE_ORDER_SIMILARITY); // ...in a clearly different order
  assert.deepEqual(findNearDuplicates(swap), []);
  assert.equal(validateQuiz(withOptions(swap)).ok, true);
});

test('the same words backwards, or with whole halves swapped, are not near-duplicates', () => {
  assert.deepEqual(findNearDuplicates([TWELVE, 'w12 w11 w10 w09 w08 w07 w06 w05 w04 w03 w02 w01', ...FILL]), []);
  assert.deepEqual(findNearDuplicates([TWELVE, 'w07 w08 w09 w10 w11 w12 w01 w02 w03 w04 w05 w06', ...FILL]), []);
});

test('Scenario: one word changed in the same place is still a near-duplicate - the Bain case is still rejected', () => {
  assert.deepEqual(findNearDuplicates([TWELVE, 'w01 w02 w03 w04 w05 XX w07 w08 w09 w10 w11 w12', ...FILL]), [[0, 1]]);
  assert.deepEqual(findNearDuplicates([TWELVE, 'w01 w02 w03 w04 w05 w06 w07 w08 w09 w10 w11', ...FILL]), [[0, 1]]); // a word dropped at the end
});

test('exactly 0.75 in order is rejected: one word moved and one changed, in 12 words', () => {
  const moved = 'w12 w01 w02 w03 w04 w05 XX w07 w08 w09 w10 w11'; // w12 moved to the front (2 edits) and w06 changed (1 edit): 3 of 12
  assert.equal(wordOrderSimilarity(TWELVE, moved), 0.75);
  assert.ok(wordOverlap(TWELVE, moved) >= NEAR_DUPLICATE_SIMILARITY);
  assert.deepEqual(findNearDuplicates([TWELVE, moved, ...FILL]), [[0, 1]]);
});

test('just under 0.75 in order is not rejected, even when the words are the same: two words moved, 4 of 12', () => {
  const moved = 'w12 w11 w01 w02 w03 w04 w05 w06 w07 w08 w09 w10';
  assert.ok(wordOrderSimilarity(TWELVE, moved) < 0.75);
  assert.equal(wordOverlap(TWELVE, moved), 1);
  assert.deepEqual(findNearDuplicates([TWELVE, moved, ...FILL]), []);
});

test('both limits must be met: similar order with too few shared words is not a near-duplicate either', () => {
  // five of six words changed: little shared and little in order
  assert.deepEqual(findNearDuplicates(['a1 a2 a3 a4 a5 a6', 'a1 b2 b3 b4 b5 b6', ...FILL]), []);
  // plenty shared but spread so the order is off: a1..a6 against a1..a6 plus six new words (6 of 12 shared)
  assert.deepEqual(findNearDuplicates(['a1 a2 a3 a4 a5 a6', 'a1 a2 a3 a4 a5 a6 n1 n2 n3 n4 n5 n6', ...FILL]), []);
});

test('Scenario: version numbers - a one-word number change in the same place is flagged by this rule (a known limit)', () => {
  const foundry: [string, string, string, string] = ['GPT-6 family and Claude Opus 5.5', 'GPT-5 family and Claude Opus 4.0', 'GPT-6 family and Llama 3', 'GPT-4 family and Claude Opus 5.5'];
  assert.deepEqual(findNearDuplicates(foundry), [[0, 3]]); // A and D differ in one number; B and D differ in two places, which is enough to keep them apart
});

test('the pair-finding still ignores options under 4 words and exact duplicates are reported as identical first', () => {
  assert.deepEqual(findNearDuplicates(['a b c', 'a b c x', 'p q r s t', 'u v w x y']), []);
  assert.match(reason(withOptions(['same same same same', 'same same same same', 'one two three four five', 'six seven eight nine ten'])), /identical/);
});
