import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildMessages,
  countWords,
  createNebiusChat,
  extractJson,
  MAX_INPUT_CHARS,
  summarize,
  systemPrompt,
  validateSummary,
  type Chat,
  type ChatMessage,
} from './llm.ts';

const words = (n: number) => Array.from({ length: n }, (_, i) => `word${i + 1}`).join(' ');
const reply = (summary: string, content_type = 'Tech Blog') => JSON.stringify({ summary, content_type });
const article = { title: 'Add Runtime Controls to AI Agents', url: 'https://developer.nvidia.com/blog/x', text: 'Body text.' };
const noWait = { sleep: async () => {} };

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

test('counts words the way the database rule does', () => {
  assert.equal(countWords('  one two\n\tthree  '), 3);
  assert.equal(countWords(''), 0);
  assert.equal(countWords(words(57)), 57);
});

test('the prompt states the rules and carries the article', () => {
  const [system, user] = buildMessages(article);
  assert.match(system.content, /50 to 60 words/);
  assert.match(system.content, /no marketing language/);
  assert.match(system.content, /what was released or found, and why it matters/);
  for (const type of ['Research Paper', 'White Paper', 'Tech Blog', 'Release']) assert.ok(system.content.includes(type));
  assert.ok(user.content.includes(article.title) && user.content.includes(article.url) && user.content.includes('Body text.'));
});

test('long page text is cut to the configured length', () => {
  const [, user] = buildMessages({ ...article, text: 'x'.repeat(MAX_INPUT_CHARS + 5000) });
  assert.ok(user.content.includes('[truncated]'));
  assert.ok(user.content.length < MAX_INPUT_CHARS + 500);
});

test('finds the JSON in replies with blank lines, code fences, prose or reasoning', () => {
  const json = reply(words(55));
  for (const raw of [`\n\n${json}`, '```json\n' + json + '\n```', `Here it is: ${json} Hope this helps.`, `<think>count {words}</think>${json}`]) {
    assert.equal((extractJson(raw) as { summary: string }).summary, words(55));
  }
});

test('malformed replies are reported, not thrown past the caller', () => {
  assert.throws(() => extractJson('no json here'), /no JSON object/);
  assert.throws(() => extractJson('{"summary": "unterminated'), /no JSON object|not valid JSON/);
  assert.throws(() => extractJson('{summary: oops}'), /not valid JSON/);
});

test('accepts 50 and 60 words, rejects 49 and 61', () => {
  assert.equal(validateSummary({ summary: words(50), content_type: 'Release' }).ok, true);
  assert.equal(validateSummary({ summary: words(60), content_type: 'Release' }).ok, true);
  assert.match((validateSummary({ summary: words(49), content_type: 'Release' }) as { reason: string }).reason, /49 words/);
  assert.match((validateSummary({ summary: words(61), content_type: 'Release' }) as { reason: string }).reason, /61 words/);
});

test('rejects a content type that is not one of the four', () => {
  for (const content_type of ['Podcast', '', null, 42, 'Blog']) {
    const result = validateSummary({ summary: words(55), content_type });
    assert.equal(result.ok, false, String(content_type));
    assert.match((result as { reason: string }).reason, /content_type/);
  }
});

test('accepts a known content type in any letter case and stores the canonical name', () => {
  const result = validateSummary({ summary: words(55), content_type: '  tech BLOG ' });
  assert.deepEqual(result, { ok: true, value: { summary: words(55), content_type: 'Tech Blog' } });
});

test('rejects replies that are not an object or lack a summary', () => {
  for (const raw of [null, [], 'text', { content_type: 'Release' }, { summary: 12, content_type: 'Release' }]) {
    assert.equal(validateSummary(raw).ok, false);
  }
});

test('tidies whitespace in the stored summary', () => {
  const messy = words(55).replace(/ /g, '  \n ');
  const result = validateSummary({ summary: messy, content_type: 'Release' });
  assert.ok(result.ok);
  assert.equal(result.value.summary, words(55));
});

test('valid on the first try: one call', async () => {
  const { chat, calls } = scripted(reply(words(56), 'Research Paper'));
  const result = await summarize(article, chat, noWait);
  assert.deepEqual(result, { ok: true, value: { summary: words(56), content_type: 'Research Paper' }, attempts: 1, failures: [] });
  assert.equal(calls.length, 1);
});

test('a 70-word summary is retried, telling the model what was wrong, then accepted', async () => {
  const { chat, calls } = scripted(reply(words(70)), reply(words(58)));
  const result = await summarize(article, chat, noWait);
  assert.equal(result.ok, true);
  assert.equal(result.attempts, 2);
  const feedback = calls[1].at(-1)!;
  assert.equal(feedback.role, 'user');
  assert.match(feedback.content, /70 words/);
});

test('Scenario: Invalid model output is rejected - retried up to 2 times, then skipped with a reason', async () => {
  const { chat, calls } = scripted(reply(words(70)));
  const result = await summarize(article, chat, noWait);
  assert.equal(calls.length, 3); // the first try plus 2 retries
  assert.deepEqual(result, {
    ok: false,
    reason: 'summary has 70 words; it must have 50 to 60',
    attempts: 3,
    failures: Array(3).fill('summary has 70 words; it must have 50 to 60'),
  });
});

test('Scenario: Unknown content type is rejected - "Podcast" is treated as invalid', async () => {
  const { chat, calls } = scripted(reply(words(55), 'Podcast'));
  const result = await summarize(article, chat, noWait);
  assert.equal(result.ok, false);
  assert.match((result as { reason: string }).reason, /Podcast/);
  assert.equal(calls.length, 3);
});

test('malformed JSON is retried and can recover', async () => {
  const { chat } = scripted('{"summary": oops', reply(words(55)));
  const result = await summarize(article, chat, noWait);
  assert.equal(result.ok, true);
  assert.equal(result.attempts, 2);
});

test('a failed model call counts as an attempt and never throws', async () => {
  const flaky = scripted(new Error('Token Factory answered HTTP 503'), reply(words(55)));
  assert.equal((await summarize(article, flaky.chat, noWait)).ok, true);

  const down = scripted(new Error('Token Factory answered HTTP 503'));
  const result = await summarize(article, down.chat, noWait);
  assert.deepEqual(result, {
    ok: false,
    reason: 'model call failed: Token Factory answered HTTP 503',
    attempts: 3,
    failures: Array(3).fill('model call failed: Token Factory answered HTTP 503'),
  });
});

test('records why every rejected attempt failed, even when a later one succeeds', async () => {
  const { chat } = scripted(reply(words(70)), 'not json at all', reply(words(55)));
  const result = await summarize(article, chat, noWait);
  assert.equal(result.ok, true);
  assert.equal(result.attempts, 3);
  assert.deepEqual(result.failures, ['summary has 70 words; it must have 50 to 60', 'reply contains no JSON object']);
});

test('records a mix of failure kinds on a final failure', async () => {
  const { chat } = scripted(new Error('Token Factory answered HTTP 429'), reply(words(55), 'Podcast'), reply(words(30)));
  const result = await summarize(article, chat, noWait);
  assert.equal(result.ok, false);
  assert.equal(result.failures.length, 3);
  assert.match(result.failures[0], /HTTP 429/);
  assert.match(result.failures[1], /Podcast/);
  assert.match(result.failures[2], /30 words/);
  assert.equal((result as { reason: string }).reason, result.failures[2]);
});

test('waits a little longer before each retry', async () => {
  const waits: number[] = [];
  const { chat } = scripted(reply(words(70)));
  await summarize(article, chat, { sleep: async (ms) => void waits.push(ms), retryDelayMs: 1000 });
  assert.deepEqual(waits, [1000, 2000]);
});

test('the number of retries is configurable', async () => {
  const { chat, calls } = scripted(reply(words(70)));
  await summarize(article, chat, { ...noWait, retries: 0 });
  assert.equal(calls.length, 1);
});

// ---- the Nebius client, with a fake fetch ----

const KEY = 'nebius-test-key-value';

function fakeFetch(respond: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const sent: { url: string; init: RequestInit }[] = [];
  const fn = (async (url: string, init: RequestInit) => {
    sent.push({ url, init });
    return respond(url, init);
  }) as unknown as typeof fetch;
  return { fn, sent };
}
const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });

test('calls Token Factory with the key, model and token limit, and returns the reply text', async () => {
  const { fn, sent } = fakeFetch(() => ok({ choices: [{ message: { content: '\n\n{"a":1}' }, finish_reason: 'stop' }] }));
  const chat = createNebiusChat({ apiKey: KEY, model: 'nvidia/nemotron-3-super-120b-a12b', fetchFn: fn });
  assert.equal(await chat([{ role: 'user', content: 'hi' }]), '\n\n{"a":1}');
  assert.equal(sent[0].url, 'https://api.tokenfactory.nebius.com/v1/chat/completions');
  assert.equal((sent[0].init.headers as Record<string, string>).Authorization, `Bearer ${KEY}`);
  const body = JSON.parse(sent[0].init.body as string);
  assert.equal(body.model, 'nvidia/nemotron-3-super-120b-a12b');
  assert.equal(body.max_tokens, 8000);
});

test('an HTTP error reports the status and never the key or the response body', async () => {
  const { fn } = fakeFetch(() => new Response(`{"error":"bad key ${KEY}"}`, { status: 401 }));
  const chat = createNebiusChat({ apiKey: KEY, model: 'm', fetchFn: fn });
  await assert.rejects(chat([]), (error: Error) => {
    assert.equal(error.message, 'Token Factory answered HTTP 401');
    assert.ok(!error.message.includes(KEY));
    return true;
  });
});

test('a reply cut off at the token limit is an error, not a half answer', async () => {
  const { fn } = fakeFetch(() => ok({ choices: [{ message: { content: '{"summary": "half' }, finish_reason: 'length' }] }));
  await assert.rejects(createNebiusChat({ apiKey: KEY, model: 'm', fetchFn: fn })([]), /cut off/);
});

test('an empty reply is an error', async () => {
  const { fn } = fakeFetch(() => ok({ choices: [{ message: { content: '  ' }, finish_reason: 'stop' }] }));
  await assert.rejects(createNebiusChat({ apiKey: KEY, model: 'm', fetchFn: fn })([]), /empty/);
});

test('gives up after the timeout instead of hanging', async () => {
  const { fn } = fakeFetch((_url, init) => new Promise((_resolve, reject) => {
    init.signal!.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
  }));
  await assert.rejects(createNebiusChat({ apiKey: KEY, model: 'm', fetchFn: fn, timeoutMs: 50 })([]), /no reply within 0.05 seconds/);
});

// The wording the seven tech companies were tested against, live, before business sources existed.
const ORIGINAL_TECH_PROMPT =
  'You summarize technology articles for a reading app. Reply with one JSON object and nothing else: ' +
  '{"summary": string, "content_type": one of "Research Paper", "White Paper", "Tech Blog", "Release"}. ' +
  'The summary must be 50 to 60 words. Count the words carefully before answering. ' +
  'Write in a factual tone with no marketing language. Say what was released or found, and why it matters. ' +
  'content_type: "Research Paper" for papers reporting research results; "White Paper" for in-depth guides, ' +
  'reports or frameworks; "Release" for announcements of a product, model, version or feature; ' +
  '"Tech Blog" for engineering or technical blog posts.';

const BUSINESS = { choose: ['Consulting', 'Finance', 'Venture Capital'] } as const;
const FIXED = { fixed: 'Venture Capital' } as const;

test('the seven tech companies still get exactly the prompt they were tested with', () => {
  assert.equal(systemPrompt(), ORIGINAL_TECH_PROMPT);
  assert.equal(systemPrompt({ choose: ['Research Paper', 'White Paper', 'Tech Blog', 'Release'] }), ORIGINAL_TECH_PROMPT);
  assert.equal(buildMessages(article)[0].content, ORIGINAL_TECH_PROMPT);
});

test('Scenario: Business tags - a source where the model chooses is offered Consulting, Finance and Venture Capital only', () => {
  const prompt = systemPrompt(BUSINESS);
  assert.match(prompt, /business and finance articles/);
  assert.match(prompt, /"content_type": one of "Consulting", "Finance", "Venture Capital"\}/);
  for (const type of ['Consulting', 'Finance', 'Venture Capital']) assert.ok(prompt.includes(`"${type}" for`), type);
  for (const type of ['Research Paper', 'White Paper', 'Tech Blog', 'Release']) assert.ok(!prompt.includes(type), type);
  assert.match(prompt, /50 to 60 words/);
  assert.match(prompt, /no marketing language/);
});

test('a source with one fixed tag asks the model for the summary only', () => {
  const prompt = systemPrompt(FIXED);
  assert.match(prompt, /\{"summary": string\}/);
  assert.ok(!prompt.includes('content_type'));
  assert.match(prompt, /50 to 60 words/);
});

test('the rule reaches the prompt that is sent', () => {
  assert.equal(buildMessages(article, MAX_INPUT_CHARS, BUSINESS)[0].content, systemPrompt(BUSINESS));
  assert.equal(buildMessages(article, MAX_INPUT_CHARS, FIXED)[0].content, systemPrompt(FIXED));
});

test('with a fixed tag the model\'s own content_type is ignored, even a wrong or missing one', () => {
  for (const raw of [
    { summary: words(55), content_type: 'Release' },
    { summary: words(55), content_type: 'Podcast' },
    { summary: words(55) },
    { summary: words(55), content_type: 'Venture Capital' },
  ]) {
    assert.deepEqual(validateSummary(raw, FIXED), { ok: true, value: { summary: words(55), content_type: 'Venture Capital' } });
  }
});

test('with a fixed tag the summary length is still enforced', () => {
  assert.equal(validateSummary({ summary: words(49) }, FIXED).ok, false);
  assert.equal(validateSummary({ summary: words(61) }, FIXED).ok, false);
  assert.equal(validateSummary({ summary: words(60) }, FIXED).ok, true);
});

test('where the model chooses among business tags, it must pick one of them (any letter case)', () => {
  assert.deepEqual(validateSummary({ summary: words(55), content_type: 'venture capital' }, BUSINESS), {
    ok: true,
    value: { summary: words(55), content_type: 'Venture Capital' },
  });
  assert.equal((validateSummary({ summary: words(55), content_type: 'CONSULTING' }, BUSINESS) as { value: { content_type: string } }).value.content_type, 'Consulting');
  for (const bad of ['Release', 'Tech Blog', 'Research Paper', 'Podcast', '', undefined, 3]) {
    const result = validateSummary({ summary: words(55), content_type: bad }, BUSINESS);
    assert.equal(result.ok, false, String(bad));
    if (!result.ok) assert.match(result.reason, /is not one of Consulting, Finance, Venture Capital/);
  }
});

test('the seven tech companies cannot be given a business tag by the model, and still pick their four', () => {
  for (const bad of ['Consulting', 'Finance', 'Venture Capital']) assert.equal(validateSummary({ summary: words(55), content_type: bad }).ok, false, bad);
  for (const good of ['Research Paper', 'White Paper', 'Tech Blog', 'Release']) assert.equal(validateSummary({ summary: words(55), content_type: good }).ok, true, good);
  const result = validateSummary({ summary: words(55), content_type: 'Consulting' });
  if (!result.ok) assert.match(result.reason, /is not one of Research Paper, White Paper, Tech Blog, Release/);
});

test('summarize with a fixed tag stores that tag whatever the model says, with no retry needed', async () => {
  const { chat, calls } = scripted(JSON.stringify({ summary: words(55), content_type: 'Release' }));
  const result = await summarize(article, chat, { ...noWait, tags: FIXED });
  assert.ok(result.ok && result.value.content_type === 'Venture Capital' && result.attempts === 1);
  assert.equal(calls[0][0].content, systemPrompt(FIXED));
});

test('summarize where the model chooses retries a type from the wrong group, and tells it the allowed ones', async () => {
  const { chat, calls } = scripted(reply(words(55), 'Release'), reply(words(55), 'Finance'));
  const result = await summarize(article, chat, { ...noWait, tags: BUSINESS });
  assert.ok(result.ok && result.value.content_type === 'Finance' && result.attempts === 2);
  assert.match(calls[1].at(-1)!.content, /is not one of Consulting, Finance, Venture Capital/);
});

test('summarize without a rule behaves as before for tech companies', async () => {
  const { chat } = scripted(reply(words(55), 'Release'));
  const result = await summarize(article, chat, noWait);
  assert.ok(result.ok && result.value.content_type === 'Release');
});


test('reports the token counts of a reply, when asked to', async () => {
  const seen: unknown[] = [];
  const usage = { prompt_tokens: 120, completion_tokens: 80, total_tokens: 200 };
  const { fn } = fakeFetch(() => ok({ choices: [{ message: { content: '{"a":1}' }, finish_reason: 'stop' }], usage }));
  await createNebiusChat({ apiKey: KEY, model: 'm', fetchFn: fn, onUsage: (u) => seen.push(u) })([]);
  assert.deepEqual(seen, [usage]);
  // a reply without usage, or no listener, is fine
  const { fn: bare } = fakeFetch(() => ok({ choices: [{ message: { content: '{"a":1}' }, finish_reason: 'stop' }] }));
  await createNebiusChat({ apiKey: KEY, model: 'm', fetchFn: bare, onUsage: (u) => seen.push(u) })([]);
  await createNebiusChat({ apiKey: KEY, model: 'm', fetchFn: fn })([]);
  assert.equal(seen.length, 1);
});

test('a model call refused as too busy (429) or failing on the server (5xx) is tried again after a wait, and other failures are not', async () => {
  const { retryBusy } = await import('./llm.ts');
  const waits: number[] = [];
  let calls = 0;
  const flaky: Chat = async () => {
    if (++calls < 3) throw new Error('Token Factory answered HTTP 429');
    return 'ok';
  };
  assert.equal(await retryBusy(flaky, { sleep: async (ms) => void waits.push(ms) })([]), 'ok');
  assert.deepEqual(waits, [2000, 5000]);

  calls = 0;
  const bad: Chat = async () => (calls++, Promise.reject(new Error('Token Factory answered HTTP 400')));
  await assert.rejects(retryBusy(bad, { sleep: async () => {} })([]), /HTTP 400/);
  assert.equal(calls, 1);

  calls = 0;
  const down: Chat = async () => (calls++, Promise.reject(new Error('Token Factory answered HTTP 503')));
  await assert.rejects(retryBusy(down, { sleep: async () => {} })([]), /HTTP 503/);
  assert.equal(calls, 4); // the first try and three more
});
