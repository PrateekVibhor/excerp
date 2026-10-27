import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { SourceCompany } from '../../src/data/types.ts';
import type { ArticleStore, NewArticle } from './db.ts';
import { TAGS } from './config.ts';
import { summarize as summarizeWithModel, type Chat, type SummarizeResult } from './llm.ts';
import { generateQuiz, type QuizGeneration } from './quiz.ts';
import { cleanTitle, normalizeUrl, runPipeline, type LogEvent, type PipelineDeps } from './pipeline.ts';
import type { FoundArticle, SearchResult } from './tavily.ts';

const words = (n: number) => Array.from({ length: n }, (_, i) => `w${i}`).join(' ');
const good = (type = 'Tech Blog'): SummarizeResult => ({ ok: true, value: { summary: words(55), content_type: type as never }, attempts: 1, failures: [] });

function found(company: SourceCompany, slug: string, publishedAt: string | null = '2026-09-28T08:00:00.000Z', extra: Partial<FoundArticle> = {}): FoundArticle {
  return { company, url: `https://example.test/${company.toLowerCase()}/${slug}`, title: `A post about ${slug} | ${company} Blog`, publishedAt, text: 'page text', ...extra };
}

/** An in-memory store with the same unique-URL rule as the database. */
function memoryStore(failOnUrl?: string) {
  const rows: NewArticle[] = [];
  const store: ArticleStore = {
    async existingUrls(urls) {
      return new Set(urls.filter((u) => rows.some((r) => r.source_url === u)));
    },
    async insert(a) {
      if (a.source_url === failOnUrl) throw new Error('new row violates check constraint "articles_summary_check"');
      if (rows.some((r) => r.source_url === a.source_url)) return false;
      rows.push(a);
      return true;
    },
  };
  return { store, rows };
}

function setup(results: Partial<Record<SourceCompany, SearchResult | Error>>, overrides: Partial<PipelineDeps> = {}) {
  const logs: LogEvent[] = [];
  const memory = memoryStore();
  const summarized: string[] = [];
  const deps: PipelineDeps = {
    companies: Object.keys(results) as SourceCompany[],
    search: async (company) => {
      const r = results[company]!;
      if (r instanceof Error) throw r;
      return r;
    },
    summarize: async (a) => {
      summarized.push(a.url);
      return good();
    },
    store: memory.store,
    maxPerCompany: 3,
    log: (e) => logs.push(e),
    now: () => new Date('2026-10-04T12:00:00Z'),
    readerCount: () => 123,
    ...overrides,
  };
  return { deps, logs, memory, summarized };
}

const ok = (...kept: FoundArticle[]): SearchResult => ({ kept, dropped: [] });

test('stores new articles in the Article shape with a cleaned title', async () => {
  const { deps, memory } = setup({ NVIDIA: ok(found('NVIDIA', 'cuda-rust')) });
  const report = await runPipeline(deps);
  assert.equal(report.stored, 1);
  assert.deepEqual(memory.rows[0], {
    source_company: 'NVIDIA',
    source_url: 'https://example.test/nvidia/cuda-rust',
    content_type: 'Tech Blog',
    title: 'A post about cuda-rust',
    summary: words(55),
    published_at: '2026-09-28T08:00:00.000Z',
    fetched_at: '2026-10-04T12:00:00.000Z',
    reader_count: 123,
    quiz: null,
    topic: null,
  });
});

test('stores at most the per-company cap, newest first', async () => {
  const items = ['a', 'b', 'c', 'd', 'e'].map((s, i) => found('Google', `post-${s}`, `2026-09-2${i}T00:00:00.000Z`));
  const { deps, memory, logs } = setup({ Google: ok(...items) });
  await runPipeline(deps);
  assert.deepEqual(memory.rows.map((r) => r.source_url.split('/').at(-1)), ['post-e', 'post-d', 'post-c']);
  assert.equal(logs.filter((l) => l.event === 'skipped' && l.reason === 'over the per-run cap').length, 2);
});

test('a rejected summary does not use up a slot, and its failures are logged', async () => {
  const items = ['a', 'b', 'c', 'd'].map((s, i) => found('Meta', `post-${s}`, `2026-09-2${i}T00:00:00.000Z`));
  const { deps, memory, logs } = setup({ Meta: ok(...items) }, {
    summarize: async (a) =>
      a.url.endsWith('post-d')
        ? { ok: false, reason: 'summary has 70 words; it must have 50 to 60', attempts: 3, failures: Array(3).fill('summary has 70 words; it must have 50 to 60') }
        : good(),
  });
  await runPipeline(deps);
  assert.equal(memory.rows.length, 3); // d failed, so a, b and c fill the cap
  const rejected = logs.find((l) => l.reason === 'summary rejected')!;
  assert.match(String(rejected.url), /post-d$/);
  assert.equal((rejected.failures as string[]).length, 3);
});

test('a summary that needed retries is stored, and the retry reasons are logged', async () => {
  const { deps, logs } = setup({ OpenAI: ok(found('OpenAI', 'introducing-dots')) }, {
    summarize: async () => ({ ...good(), attempts: 2, failures: ['summary has 48 words; it must have 50 to 60'] }),
  });
  await runPipeline(deps);
  const retried = logs.find((l) => l.event === 'summary_retried')!;
  assert.deepEqual(retried.failures, ['summary has 48 words; it must have 50 to 60']);
});

test('skips items with no published date, without calling the model', async () => {
  const { deps, memory, summarized, logs } = setup({ AWS: ok(found('AWS', 'undated-post', null), found('AWS', 'dated-post')) });
  await runPipeline(deps);
  assert.deepEqual(memory.rows.map((r) => r.source_url.split('/').at(-1)), ['dated-post']);
  assert.ok(!summarized.some((u) => u.includes('undated-post')));
  assert.ok(logs.some((l) => l.reason === 'no published date'));
});

test('Scenario: Store without duplicates - a URL already stored is never stored or summarized again', async () => {
  const results = { Anthropic: ok(found('Anthropic', 'claude-shaped-science'), found('Anthropic', 'what-work-can-robots-do')) };
  const first = setup(results);
  await runPipeline(first.deps);
  assert.equal(first.memory.rows.length, 2);

  // The pipeline sees the same articles again, against the same store.
  const second = setup(results, { store: first.memory.store });
  const report = await runPipeline(second.deps);
  assert.equal(report.stored, 0);
  assert.equal(first.memory.rows.length, 2);
  assert.deepEqual(second.summarized, []); // no model cost for known articles
  assert.equal(second.logs.filter((l) => l.reason === 'already stored').length, 2);
});

test('the same article with tracking parameters or a trailing slash counts as one', async () => {
  const base = found('Anthropic', 'claude-shaped-science');
  const { deps, memory } = setup({
    Anthropic: ok(base, { ...base, url: `${base.url}?_bhlid=abc123` }, { ...base, url: `${base.url}/#section` }),
  });
  await runPipeline(deps);
  assert.equal(memory.rows.length, 1);
  assert.equal(memory.rows[0].source_url, 'https://example.test/anthropic/claude-shaped-science');
});

test('Scenario: One failure does not stop the run - a failed search, model call or insert only affects its own item', async () => {
  const memory = memoryStore('https://example.test/google/bad-insert');
  const { deps, logs } = setup(
    {
      NVIDIA: new Error('Tavily answered HTTP 429'),
      Google: ok(found('Google', 'bad-insert'), found('Google', 'fine-one')),
      Meta: ok(found('Meta', 'model-throws'), found('Meta', 'fine-two')),
    },
    {
      store: memory.store,
      summarize: async (a) => {
        if (a.url.endsWith('model-throws')) throw new Error('unexpected');
        return good();
      },
    },
  );
  // A model call that throws is outside summarize()'s contract, but must still not stop the run.
  const safeDeps: PipelineDeps = {
    ...deps,
    summarize: async (a, c) => deps.summarize(a, c).catch((e: Error) => ({ ok: false as const, reason: e.message, attempts: 1, failures: [e.message] })),
  };
  const report = await runPipeline(safeDeps);
  assert.equal(report.companies.NVIDIA?.error, 'Tavily answered HTTP 429');
  assert.deepEqual(memory.rows.map((r) => r.source_url.split('/').at(-1)).sort(), ['fine-one', 'fine-two']);
  assert.ok(logs.some((l) => l.event === 'search_failed' && l.company === 'NVIDIA'));
  assert.ok(logs.some((l) => l.reason === 'insert failed'));
  assert.equal(logs.at(-1)!.event, 'run_finished');
});

test('a database outage for one company is logged and the run continues', async () => {
  const memory = memoryStore();
  let calls = 0;
  const flakyStore: ArticleStore = {
    existingUrls: async (urls) => {
      if (calls++ === 0) throw new Error('connection refused');
      return memory.store.existingUrls(urls);
    },
    insert: memory.store.insert,
  };
  const { deps, logs } = setup({ NVIDIA: ok(found('NVIDIA', 'one-post')), Google: ok(found('Google', 'two-post')) }, { store: flakyStore });
  const report = await runPipeline(deps);
  assert.match(report.companies.NVIDIA!.error!, /database: connection refused/);
  assert.equal(report.companies.Google!.stored, 1);
  assert.ok(logs.some((l) => l.event === 'database_failed'));
});

test('items Tavily dropped are logged with their reasons', async () => {
  const { deps, logs } = setup({ Microsoft: { kept: [], dropped: [{ url: 'https://learn.microsoft.com/x', reason: 'not an approved source' }] } });
  const report = await runPipeline(deps);
  assert.deepEqual(report.companies.Microsoft!.skipped, { 'not an approved source': 1 });
  assert.ok(logs.some((l) => l.reason === 'not an approved source'));
});

test('logs never carry the page text', async () => {
  const { deps, logs } = setup({ NVIDIA: ok(found('NVIDIA', 'secret-text-post', '2026-09-28T00:00:00.000Z', { text: 'FULL PAGE TEXT SHOULD NOT BE LOGGED' })) });
  await runPipeline(deps);
  assert.ok(!JSON.stringify(logs).includes('FULL PAGE TEXT'));
});

test('normalizeUrl drops query, fragment and trailing slash, and lowercases the host', () => {
  assert.equal(normalizeUrl('https://WWW.Anthropic.com/research/x/?_bhlid=1#top'), 'https://www.anthropic.com/research/x');
  assert.equal(normalizeUrl('https://openai.com/'), 'https://openai.com/');
});

test('cleanTitle removes trailing site names but keeps real headlines', () => {
  assert.equal(cleanTitle('Introducing CUDA Rust: Two Tracks for Writing GPU Kernels | NVIDIA Technical Blog', 'NVIDIA'), 'Introducing CUDA Rust: Two Tracks for Writing GPU Kernels');
  assert.equal(cleanTitle('Countering misuse of AI: September 2026 / Anthropic \\ Anthropic', 'Anthropic'), 'Countering misuse of AI: September 2026');
  assert.equal(cleanTitle('Bringing Private Processing to Meta AI Glasses - Engineering at Meta', 'Meta'), 'Bringing Private Processing to Meta AI Glasses');
  assert.equal(cleanTitle('Prompt engineering fundamentals for Amazon Quick | Artificial Intelligence', 'AWS'), 'Prompt engineering fundamentals for Amazon Quick');
  assert.equal(cleanTitle('Advancing confidential AI with secure memory — Google DeepMind', 'Google'), 'Advancing confidential AI with secure memory');
  // Not site names: kept as they are.
  assert.equal(cleanTitle('Gemini 3.8 Live & Gemini 3.8 Live Extended Thinking', 'Google'), 'Gemini 3.8 Live & Gemini 3.8 Live Extended Thinking');
  assert.equal(cleanTitle('On the Navier–Stokes Millennium Prize Problem', 'OpenAI'), 'On the Navier–Stokes Millennium Prize Problem');
  assert.equal(cleanTitle('Self-driving cars - a new benchmark for safety evaluation', 'Google'), 'Self-driving cars - a new benchmark for safety evaluation');
});

// ---- Business and Finance -------------------------------------------------------------------------

const modelSays = (content_type: string): Chat => async () => JSON.stringify({ summary: words(55), content_type });

/** The pipeline wired as in production: the real summarizer, given the tag rule of the company being processed. */
const withRealSummarizer = (chat: Chat): Partial<PipelineDeps> => ({
  summarize: (article, company) => summarizeWithModel(article, chat, { sleep: async () => {}, tags: TAGS[company] }),
});

test('the summarizer is told which company an article belongs to', async () => {
  const seen: Array<[string, SourceCompany]> = [];
  const { deps } = setup(
    { NVIDIA: ok(found('NVIDIA', 'a')), McKinsey: ok(found('McKinsey', 'b')) },
    { summarize: async (a, company) => (seen.push([a.url.split('/').at(-1)!, company]), good()) },
  );
  await runPipeline(deps);
  assert.deepEqual(seen, [['a', 'NVIDIA'], ['b', 'McKinsey']]);
});

test('Scenario: Business tags - a source with a fixed tag is stored under it, whatever the model answers', async () => {
  const expected: Array<[SourceCompany, string]> = [
    ['McKinsey', 'Consulting'], ['BCG', 'Consulting'], ['Bain & Company', 'Consulting'],
    ['CFA Institute', 'Finance'], ['BlackRock', 'Finance'],
    ['Y Combinator', 'Venture Capital'], ['Sequoia Capital', 'Venture Capital'], ['Andreessen Horowitz', 'Venture Capital'], ['General Catalyst', 'Venture Capital'],
  ];
  for (const model of ['Release', 'Podcast', 'Finance']) {
    const { deps, memory } = setup(
      Object.fromEntries(expected.map(([company]) => [company, ok(found(company, 'post'))])) as never,
      withRealSummarizer(modelSays(model)),
    );
    await runPipeline(deps);
    assert.deepEqual(memory.rows.map((r) => [r.source_company, r.content_type]), expected, `model said ${model}`);
  }
});

test('Scenario: Business tags - HBR, MIT SMR and the World Economic Forum are stored under the tag the model picks', async () => {
  const companies = ['Harvard Business Review', 'MIT Sloan Management Review', 'World Economic Forum'] as const;
  for (const pick of ['Consulting', 'Finance', 'Venture Capital']) {
    const { deps, memory } = setup(Object.fromEntries(companies.map((c) => [c, ok(found(c, 'post'))])) as never, withRealSummarizer(modelSays(pick)));
    await runPipeline(deps);
    assert.deepEqual(memory.rows.map((r) => r.content_type), [pick, pick, pick]);
  }
});

test('where the model chooses, a tech type is refused and the article is skipped after the retries', async () => {
  const { deps, memory, logs } = setup({ 'Harvard Business Review': ok(found('Harvard Business Review', 'post')) }, withRealSummarizer(modelSays('Tech Blog')));
  await runPipeline(deps);
  assert.equal(memory.rows.length, 0);
  const skip = logs.find((l) => l.event === 'skipped' && l.reason === 'summary rejected')!;
  assert.match(String((skip.failures as string[])[0]), /is not one of Consulting, Finance, Venture Capital/);
});

test('the seven tech companies are unaffected: they still choose their own type and cannot get a business one', async () => {
  const { deps, memory } = setup({ Google: ok(found('Google', 'launch')) }, withRealSummarizer(modelSays('Release')));
  await runPipeline(deps);
  assert.equal(memory.rows[0].content_type, 'Release');
  const refused = setup({ Google: ok(found('Google', 'launch')) }, withRealSummarizer(modelSays('Consulting')));
  await runPipeline(refused.deps);
  assert.equal(refused.memory.rows.length, 0);
});

test('the per-company cap applies to every publisher alike', async () => {
  const articles = ['a', 'b', 'c', 'd', 'e'].map((slug, i) => found('Andreessen Horowitz', slug, `2026-09-2${i}T08:00:00.000Z`));
  const { deps, memory } = setup({ 'Andreessen Horowitz': ok(...articles) }, withRealSummarizer(modelSays('anything')));
  await runPipeline(deps);
  assert.equal(memory.rows.length, 3);
});

test('a publisher that finds nothing (General Catalyst today) costs nothing but its search, and does not stop the run', async () => {
  const { deps, memory, logs } = setup({ 'General Catalyst': ok(), 'Andreessen Horowitz': ok(found('Andreessen Horowitz', 'post')) }, withRealSummarizer(modelSays('x')));
  const report = await runPipeline(deps);
  assert.equal(report.companies['General Catalyst']?.found, 0);
  assert.equal(memory.rows.length, 1);
  assert.ok(logs.some((l) => l.event === 'company_done' && l.company === 'General Catalyst' && l.found === 0));
});

test('titles of the new publishers lose their site names, using the real titles seen in the searches', () => {
  const cases: Array<[SourceCompany, string, string]> = [
    ['McKinsey', 'AI leadership for CEOs: A strategic imperative | McKinsey', 'AI leadership for CEOs: A strategic imperative'],
    ['BCG', 'AI\'s Share of IT Budgets Is Rising Fast in 2026 | BCG', 'AI\'s Share of IT Budgets Is Rising Fast in 2026'],
    ['Bain & Company', 'How to Unlock Payments Value in Portfolio Companies | Bain & Company', 'How to Unlock Payments Value in Portfolio Companies'],
    ['CFA Institute', 'Now AI Can Pass Mock Exams. Can it Replace Investment Analysis? | EI Blog', 'Now AI Can Pass Mock Exams. Can it Replace Investment Analysis?'],
    ['BlackRock', 'Market neutral investing | BlackRock', 'Market neutral investing'],
    ['World Economic Forum', 'Throwaway economics: Can AI monetize our waste? | World Economic Forum', 'Throwaway economics: Can AI monetize our waste?'],
    ['Sequoia Capital', 'Partnering with Cymphony: Security Unlocks Adoption | Sequoia Capital | Sequoia Capital', 'Partnering with Cymphony: Security Unlocks Adoption'],
    ['Andreessen Horowitz', 'Who Gets Paid When AI Does the Shopping? | Andreessen Horowitz', 'Who Gets Paid When AI Does the Shopping?'],
    ['Y Combinator', 'How to Build an AI-Native Services Company  : YC Startup Library | Y Combinator', 'How to Build an AI-Native Services Company'],
    ['Y Combinator', 'How To Pick A Startup Idea  : YC Startup Library | Y Combinator', 'How To Pick A Startup Idea'],
  ];
  for (const [company, raw, expected] of cases) assert.equal(cleanTitle(raw, company), expected, raw);
});

test('real headlines are not shortened: a colon or a dash inside a headline stays', () => {
  assert.equal(cleanTitle('AI drug discovery: Focusing on what matters most | McKinsey', 'McKinsey'), 'AI drug discovery: Focusing on what matters most');
  assert.equal(cleanTitle('Garry Tan: Own Your Intelligence : YC Startup Library | Y Combinator', 'Y Combinator'), 'Garry Tan: Own Your Intelligence');
  assert.equal(cleanTitle('The $100-Billion SaaS Opportunity Hiding in Cross-System Labor | Bain & Company', 'Bain & Company'), 'The $100-Billion SaaS Opportunity Hiding in Cross-System Labor');
});


// ---- Feature 8: quiz and topic ---------------------------------------------------------------

const QUIZ = {
  questions: [1, 2, 3].map((n) => ({ prompt: `Question ${n}?`, options: ['A', 'B', 'C', 'D'].map((o) => `${o}${n}`), correct_index: n })),
};
const quizOk = (failures: string[] = []): QuizGeneration => ({ ok: true, value: { quiz: QUIZ, topic: 'Agents' }, attempts: failures.length + 1, failures });
const quizFailed: QuizGeneration = { ok: false, reason: 'quiz must have exactly 3 questions', attempts: 3, failures: ['reason one', 'reason two', 'quiz must have exactly 3 questions'] };

test('Scenario: quiz stored with the article - the quiz and topic are stored beside the summary', async () => {
  const { deps, memory, logs } = setup({ NVIDIA: ok(found('NVIDIA', 'a')) }, { makeQuiz: async () => quizOk() });
  const report = await runPipeline(deps);
  assert.equal(report.stored, 1);
  assert.deepEqual(memory.rows[0].quiz, QUIZ);
  assert.equal(memory.rows[0].topic, 'Agents');
  assert.deepEqual(logs.find((l) => l.event === 'stored'), { event: 'stored', company: 'NVIDIA', url: 'https://example.test/nvidia/a', content_type: 'Tech Blog', attempts: 1, quiz: true, topic: 'Agents' });
});

test('the quiz is made from the validated summary only, never the page text', async () => {
  const seen: string[] = [];
  const { deps } = setup(
    { NVIDIA: ok(found('NVIDIA', 'a', undefined, { text: 'SECRET PAGE TEXT' })) },
    { summarize: async () => good(), makeQuiz: async (summary) => (seen.push(summary), quizOk()) },
  );
  await runPipeline(deps);
  assert.deepEqual(seen, [words(55)]);
});

test('Scenario: Article kept without a quiz - a quiz that fails after all retries leaves quiz and topic null, and the article is stored', async () => {
  const { deps, memory, logs } = setup({ NVIDIA: ok(found('NVIDIA', 'a'), found('NVIDIA', 'b')) }, { makeQuiz: async () => quizFailed });
  const report = await runPipeline(deps);
  assert.equal(report.stored, 2);
  assert.equal(memory.rows.length, 2);
  for (const row of memory.rows) {
    assert.equal(row.quiz, null);
    assert.equal(row.topic, null);
    assert.equal(row.summary, words(55)); // the summary itself is untouched
  }
  const rejected = logs.filter((l) => l.event === 'quiz_rejected');
  assert.equal(rejected.length, 2);
  assert.deepEqual(rejected[0], { event: 'quiz_rejected', company: 'NVIDIA', url: 'https://example.test/nvidia/a', attempts: 3, failures: quizFailed.failures }); // every attempt's reason
  assert.equal(logs.filter((l) => l.event === 'stored').every((l) => l.quiz === false && l.topic === null), true);
});

test('a quiz step that throws also leaves the article stored with a null quiz', async () => {
  const { deps, memory, logs } = setup({ NVIDIA: ok(found('NVIDIA', 'a')) }, {
    makeQuiz: async () => {
      throw new Error('socket hang up');
    },
  });
  assert.equal((await runPipeline(deps)).stored, 1);
  assert.equal(memory.rows[0].quiz, null);
  assert.equal(memory.rows[0].topic, null);
  assert.deepEqual(logs.find((l) => l.event === 'quiz_rejected')?.failures, ['quiz step failed: socket hang up']);
});

test('a quiz that needed retries is stored, and the retry reasons are logged', async () => {
  const { deps, memory, logs } = setup({ NVIDIA: ok(found('NVIDIA', 'a')) }, { makeQuiz: async () => quizOk(['reply contains no JSON object']) });
  await runPipeline(deps);
  assert.deepEqual(memory.rows[0].quiz, QUIZ);
  assert.deepEqual(logs.find((l) => l.event === 'quiz_retried'), { event: 'quiz_retried', company: 'NVIDIA', url: 'https://example.test/nvidia/a', failures: ['reply contains no JSON object'] });
  assert.equal(logs.some((l) => l.event === 'quiz_rejected'), false);
});

test('without a quiz maker, articles are stored with null quiz and topic', async () => {
  const { deps, memory } = setup({ NVIDIA: ok(found('NVIDIA', 'a')) });
  await runPipeline(deps);
  assert.equal(memory.rows[0].quiz, null);
  assert.equal(memory.rows[0].topic, null);
});

test('no quiz is generated (and no tokens spent) for a rejected summary, a stored duplicate or an article over the cap', async () => {
  const quizzed: string[] = [];
  const { deps } = setup(
    { NVIDIA: ok(found('NVIDIA', 'new-1', '2026-09-30T08:00:00.000Z'), found('NVIDIA', 'bad', '2026-09-29T08:00:00.000Z'), found('NVIDIA', 'new-2', '2026-09-28T08:00:00.000Z'), found('NVIDIA', 'new-3', '2026-09-27T08:00:00.000Z'), found('NVIDIA', 'new-4', '2026-09-26T08:00:00.000Z'), found('NVIDIA', 'old', '2026-09-25T08:00:00.000Z')) },
    {
      summarize: async (a) => (a.url.endsWith('/bad') ? { ok: false, reason: 'summary has 20 words', attempts: 3, failures: ['x'] } : good()),
      makeQuiz: async (summary) => (quizzed.push(summary), quizOk()),
    },
  );
  await deps.store.insert({ source_company: 'NVIDIA', source_url: 'https://example.test/nvidia/old', content_type: 'Tech Blog', title: 't', summary: 's', published_at: '2026-09-01T00:00:00.000Z', fetched_at: '2026-09-02T00:00:00.000Z', reader_count: 1 });
  await runPipeline(deps);
  assert.equal(quizzed.length, 3); // new-1, new-2, new-3: the cap is 3; 'bad' was rejected, 'old' was stored, new-4 is over the cap
});

test('with the real quiz generator: a model that never gives a valid quiz still gets the article stored', async () => {
  const replies = ['not json', JSON.stringify({ questions: QUIZ.questions.slice(0, 2), topic: 'Agents' }), JSON.stringify({ questions: [{ ...QUIZ.questions[0], correct_index: 4 }, QUIZ.questions[1], QUIZ.questions[2]] })];
  let n = 0;
  const chat: Chat = async () => replies[n++ % replies.length];
  const { deps, memory, logs } = setup({ NVIDIA: ok(found('NVIDIA', 'a')) }, { makeQuiz: (summary) => generateQuiz(summary, chat, { sleep: async () => {}, verify: false }) });
  assert.equal((await runPipeline(deps)).stored, 1);
  assert.equal(memory.rows[0].quiz, null);
  assert.equal(memory.rows[0].topic, null);
  assert.deepEqual(logs.find((l) => l.event === 'quiz_rejected')?.failures, ['reply contains no JSON object', 'quiz must have exactly 3 questions', 'question 1 correct_index must be a whole number from 0 to 3']);
});

test('with the real quiz generator: a valid reply stores a quiz and a topic from the 8', async () => {
  const chat: Chat = async () => JSON.stringify({ questions: QUIZ.questions, topic: 'cloud' });
  const { deps, memory } = setup({ NVIDIA: ok(found('NVIDIA', 'a')) }, { makeQuiz: (summary) => generateQuiz(summary, chat, { verify: false }) });
  await runPipeline(deps);
  assert.deepEqual(memory.rows[0].quiz, QUIZ);
  assert.equal(memory.rows[0].topic, 'Cloud');
});

test('a valid quiz whose topic was not one of the 8 is still stored, with a null topic', async () => {
  const { deps, memory } = setup({ NVIDIA: ok(found('NVIDIA', 'a')) }, { makeQuiz: async () => ({ ok: true, value: { quiz: QUIZ, topic: null }, attempts: 1, failures: [] }) });
  await runPipeline(deps);
  assert.deepEqual(memory.rows[0].quiz, QUIZ);
  assert.equal(memory.rows[0].topic, null);
});

test('with no reader count given, a new article starts at 0: the number shown to readers is counted from real activity, never invented', async () => {
  const { deps, memory } = setup({ NVIDIA: ok(found('NVIDIA', 'cuda-rust')) });
  delete deps.readerCount;
  await runPipeline(deps);
  assert.equal(memory.rows[0].reader_count, 0);
});

