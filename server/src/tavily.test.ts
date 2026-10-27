import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SOURCE_COMPANIES } from '../../src/data/types.ts';
import { SOURCES, tavilyDomains } from './config.ts';
import { isApprovedSource, looksLikeArticle, MIN_ARTICLE_CHARS, queryFor, searchCompany, toIsoDate } from './tavily.ts';

const KEY = 'tvly-test-key-value';

function fakeTavily(results: unknown[], status = 200) {
  const sent: { url: string; init: RequestInit }[] = [];
  const fetchFn = (async (url: string, init: RequestInit) => {
    sent.push({ url, init });
    return new Response(status === 200 ? JSON.stringify({ results }) : `{"detail":"bad key ${KEY}"}`, { status });
  }) as unknown as typeof fetch;
  return { fetchFn, sent };
}

/** A page of article length: the least text that counts is MIN_ARTICLE_CHARS. */
const PAGE = 'Full page text. '.repeat(100);
const result = (url: string, extra: Record<string, unknown> = {}) => ({
  url,
  title: 'A title',
  content: 'short snippet',
  raw_content: PAGE,
  published_date: 'Mon, 28 Sep 2026 08:55:00 GMT',
  ...extra,
});

test('approved sources: the exact host, with or without www, never a subdomain', () => {
  const nvidia = SOURCES.NVIDIA;
  for (const ok of [
    'https://blogs.nvidia.com/blog/ai-factories',
    'https://developer.nvidia.com/blog/introducing-cuda-rust',
    'http://DEVELOPER.nvidia.com/Blog/introducing-cuda-rust',
    'https://nvidianews.nvidia.com/news/some-announcement',
  ]) {
    assert.equal(isApprovedSource(ok, nvidia), true, ok);
  }
  for (const bad of [
    'https://forums.developer.nvidia.com/t/user-post-about-a-recipe',
    'https://docs.nvidia.com/dgx/dgx-spark/dgx-spark.pdf',
    'https://www.nvidia.com/en-us/ai-data-science/foundation-models/nemotron',
    'https://developer.nvidia.com/docs/some-guide',
    'https://blogs.nvidia.com.evil.io/blog/fake-post',
    'https://notnvidia.com/blog/x',
    'ftp://blogs.nvidia.com/blog/x',
    'not a url',
  ]) {
    assert.equal(isApprovedSource(bad, nvidia), false, bad);
  }
  assert.equal(isApprovedSource('https://www.anthropic.com/research/x-y', SOURCES.Anthropic), true);
  assert.equal(isApprovedSource('https://anthropic.com/news/x-y', SOURCES.Anthropic), true);
  for (const bad of ['https://docs.anthropic.com/en/release-notes/claude-apps', 'https://support.anthropic.com/en/articles/123-x']) {
    assert.equal(isApprovedSource(bad, SOURCES.Anthropic), false, bad);
  }
});

test('an address must go beyond its pattern, so a section page itself is not approved', () => {
  assert.equal(isApprovedSource('https://nvidianews.nvidia.com/news', SOURCES.NVIDIA), false);
  assert.equal(isApprovedSource('https://aws.amazon.com/blogs/iot', SOURCES.AWS), false); // blogs/* needs a post after the blog name
  assert.equal(isApprovedSource('https://aws.amazon.com/blogs/machine-learning/migrating-agents', SOURCES.AWS), true);
  assert.equal(isApprovedSource('https://openai.com/', SOURCES.OpenAI), false);
});

test('* matches exactly one path segment, such as a locale', () => {
  assert.equal(isApprovedSource('https://azure.microsoft.com/en-us/blog/gpt-6-for-agents', SOURCES.Microsoft), true);
  assert.equal(isApprovedSource('https://www.microsoft.com/en-us/research/blog/new-method', SOURCES.Microsoft), true);
  assert.equal(isApprovedSource('https://azure.microsoft.com/blog/gpt-6-for-agents', SOURCES.Microsoft), false); // no locale segment
  for (const bad of [
    'https://techcommunity.microsoft.com/blog/industry-blog/some-post',
    'https://learn.microsoft.com/en-us/azure/foundry/transparency-note',
    'https://www.microsoft.com/en/customers/story/27321-customer',
  ]) {
    assert.equal(isApprovedSource(bad, SOURCES.Microsoft), false, bad);
  }
});

test('section, listing and index pages are not articles; real posts are', () => {
  for (const index of [
    'https://nvidianews.nvidia.com/news',
    'https://research.google/blog/',
    'https://blog.google/technology/ai/',
    'https://openai.com/',
    'https://www.anthropic.com/transparency?ref=x',
    'https://aws.amazon.com/blogs/machine-learning/category/artificial-intelligence/amazon-textract',
    'https://www.microsoft.com/insidetrack/blog',
    'https://docs.nvidia.com/learning/physical-ai/index.html',
    'https://example.com/tag/agents/some-thing',
  ]) {
    assert.equal(looksLikeArticle(index), false, index);
  }
  for (const article of [
    'https://developer.nvidia.com/blog/add-runtime-controls-to-ai-agents-with-nvidia-openshell',
    'https://openai.com/index/ringg',
    'https://www.anthropic.com/claude-sonnet-5-5',
    'https://about.fb.com/news/2026/09/introducing-muse-personal-ai-agent',
  ]) {
    assert.equal(looksLikeArticle(article), true, article);
  }
});

test('Tavily dates become ISO; missing, unreadable or future dates become null', () => {
  assert.equal(toIsoDate('Mon, 28 Sep 2026 08:55:00 GMT'), '2026-09-28T08:55:00.000Z');
  assert.equal(toIsoDate('2026-09-21'), '2026-09-21T00:00:00.000Z');
  for (const bad of [undefined, null, '', 'yesterday', 42]) assert.equal(toIsoDate(bad), null, String(bad));
  const now = Date.parse('2026-10-04T00:00:00Z');
  assert.equal(toIsoDate('2027-01-01T00:00:00Z', now), null);
});

test('every company gets its own allowlist sent to Tavily', async () => {
  for (const company of SOURCE_COMPANIES) {
    const { fetchFn, sent } = fakeTavily([]);
    await searchCompany(company, { apiKey: KEY, fetchFn });
    const body = JSON.parse(sent[0].init.body as string);
    assert.deepEqual(body.include_domains, tavilyDomains(company), company);
  }
});

test('sends a basic, recent, dated search with the key in the header', async () => {
  const { fetchFn, sent } = fakeTavily([]);
  await searchCompany('Anthropic', { apiKey: KEY, fetchFn });
  assert.equal(sent[0].url, 'https://api.tavily.com/search');
  assert.equal((sent[0].init.headers as Record<string, string>).Authorization, `Bearer ${KEY}`);
  const body = JSON.parse(sent[0].init.body as string);
  assert.equal(body.search_depth, 'basic'); // 1 credit, not 2
  assert.equal(body.time_range, 'month');
  assert.equal(body.include_published_date, true);
  assert.equal(body.include_raw_content, 'text');
  assert.match(body.query, /Anthropic/);
  assert.ok(!(sent[0].init.body as string).includes(KEY), 'the key goes in the header only');
});

test('Scenario: Fetch from official sources - only approved-source results are kept', async () => {
  const { fetchFn } = fakeTavily([
    result('https://blogs.nvidia.com/blog/ibc-news-2026'),
    result('https://some-reseller.com/nvidia-gpu-deal-2026'),
    result('https://nvidia.com.evil.io/blog/fake-post-2026'),
    result('https://forums.developer.nvidia.com/t/community-post-2026'),
    result('https://developer.nvidia.com/blog/add-runtime-controls-2026'),
  ]);
  const { kept, dropped } = await searchCompany('NVIDIA', { apiKey: KEY, fetchFn });
  assert.deepEqual(kept.map((k) => k.url), [
    'https://blogs.nvidia.com/blog/ibc-news-2026',
    'https://developer.nvidia.com/blog/add-runtime-controls-2026',
  ]);
  assert.equal(dropped.filter((d) => d.reason === 'not an approved source').length, 3);
  for (const k of kept) assert.ok(isApprovedSource(k.url, SOURCES.NVIDIA));
});

test('drops index pages, duplicates and results without a url or title', async () => {
  const { fetchFn } = fakeTavily([
    result('https://blogs.nvidia.com/blog/category/ai'),
    result('https://blogs.nvidia.com/blog/ibc-news-2026'),
    result('https://blogs.nvidia.com/blog/ibc-news-2026'),
    result('', {}),
    result('https://blogs.nvidia.com/blog/untitled-2026', { title: '  ' }),
  ]);
  const { kept, dropped } = await searchCompany('NVIDIA', { apiKey: KEY, fetchFn });
  assert.equal(kept.length, 1);
  assert.deepEqual(dropped.map((d) => d.reason).sort(), ['duplicate in this search', 'index or listing page', 'missing url or title', 'missing url or title']);
});

test('uses the full page text when available, else a long enough snippet; keeps undated items as null for the pipeline', async () => {
  const longSnippet = 'A long snippet. '.repeat(100);
  const { fetchFn } = fakeTavily([
    result('https://blogs.nvidia.com/blog/with-page-2026'),
    result('https://blogs.nvidia.com/blog/snippet-only-2026', { raw_content: null, content: longSnippet }),
    result('https://blogs.nvidia.com/blog/undated-2026', { published_date: undefined }),
  ]);
  const { kept } = await searchCompany('NVIDIA', { apiKey: KEY, fetchFn });
  assert.equal(kept[0].text, PAGE.trim());
  assert.equal(kept[1].text, longSnippet.trim());
  assert.equal(kept[2].publishedAt, null);
  assert.equal(kept[0].publishedAt, '2026-09-28T08:55:00.000Z');
  assert.equal(kept[0].company, 'NVIDIA');
});

test('Scenario: Minimum article length - a page under 1,500 characters is dropped, for every source', async () => {
  assert.equal(MIN_ARTICLE_CHARS, 1500);
  for (const company of ['NVIDIA', 'McKinsey', 'Andreessen Horowitz'] as const) {
    const host = { NVIDIA: 'https://blogs.nvidia.com/blog/', McKinsey: 'https://www.mckinsey.com/mgi/our-research/', 'Andreessen Horowitz': 'https://a16z.com/' }[company];
    const { fetchFn } = fakeTavily([
      result(`${host}exactly-long-enough`, { raw_content: 'x'.repeat(MIN_ARTICLE_CHARS) }),
      result(`${host}one-short`, { raw_content: 'x'.repeat(MIN_ARTICLE_CHARS - 1) }),
      result(`${host}empty-extraction`, { raw_content: 'x'.repeat(153) }),
      result(`${host}snippet-only`, { raw_content: null, content: 'a snippet of a few hundred characters '.repeat(8) }),
    ]);
    const { kept, dropped } = await searchCompany(company, { apiKey: KEY, fetchFn });
    assert.deepEqual(kept.map((k) => k.url.split('/').at(-1)), ['exactly-long-enough'], company);
    assert.deepEqual(dropped.map((d) => d.reason), ['too short', 'too short', 'too short'], company);
  }
});

test('the length is counted after trimming, so padding does not make a stub an article', async () => {
  const { fetchFn } = fakeTavily([result('https://blogs.nvidia.com/blog/padded-stub', { raw_content: `${' '.repeat(3000)}tiny${' '.repeat(3000)}` })]);
  const { kept, dropped } = await searchCompany('NVIDIA', { apiKey: KEY, fetchFn });
  assert.equal(kept.length, 0);
  assert.equal(dropped[0].reason, 'too short');
});

test('an HTTP error reports the status only, never the key or body', async () => {
  const { fetchFn } = fakeTavily([], 401);
  await assert.rejects(searchCompany('Meta', { apiKey: KEY, fetchFn }), (error: Error) => {
    assert.equal(error.message, 'Tavily answered HTTP 401');
    return true;
  });
});

test('gives up after the timeout instead of hanging', async () => {
  const fetchFn = ((_url: string, init: RequestInit) => new Promise((_res, reject) => {
    init.signal!.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
  })) as unknown as typeof fetch;
  await assert.rejects(searchCompany('AWS', { apiKey: KEY, fetchFn, timeoutMs: 50 }), /no reply within 0.05 seconds/);
});

// Real addresses seen in the Tavily searches run for these sources in October 2026.
const ADMITTED: Array<[string, string[]]> = [
  ['McKinsey', ['https://www.mckinsey.com/capabilities/tech-and-ai/our-insights/the-top-trends-in-tech', 'https://www.mckinsey.com/industries/financial-services/our-insights/the-strategic-new-ground-for-insurers', 'https://www.mckinsey.com/mgi/our-research/workforce-in-motion-skills-and-pathways-to-a-future-of-work']],
  ['BCG', ['https://www.bcg.com/publications/2026/ai-share-it-budgets-rising-fast', 'https://www.bcg.com/press/30september2026-ai-starting-to-pay-off-companies-generate-value']],
  ['Bain & Company', ['https://www.bain.com/insights/how-to-unlock-payments-value-in-portfolio-companies']],
  ['CFA Institute', ['https://www.cfainstitute.org/insights/articles/how-investment-firms-are-organizing-for-ai', 'https://rpc.cfainstitute.org/blogs/enterprising-investor/2026/now-ai-can-pass-mock-exams']],
  ['Harvard Business Review', ['https://hbr.org/product/why-even-your-best-employees-override-ai-systems-that-work/BH2026']],
  ['MIT Sloan Management Review', ['https://sloanreview.mit.edu/article/why-design-thinking-needs-a-responsibility-reboot', 'https://sloanreview.mit.edu/projects/takeda-pharmaceutical-reimagining-rd-with-ai']],
  ['BlackRock', ['https://www.blackrock.com/us/financial-professionals/insights/market-neutral-investing', 'https://www.blackrock.com/us/individual/literature/market-commentary/weekly-investment-commentary']],
  ['World Economic Forum', ['https://www.weforum.org/stories/artificial-intelligence/ai-waste-value-chain', 'https://reports.weforum.org/docs/WEF_The_Resilience_to_Growth_Circularity_Playbook.pdf']],
  ['Y Combinator', ['https://www.ycombinator.com/library/Ri-how-to-pick-a-startup-idea', 'https://www.ycombinator.com/blog/the-yc-ai-student-starter-pack']],
  ['Sequoia Capital', ['https://www.sequoiacap.com/article/partnering-with-cymphony-security-unlocks-adoption']],
  ['Andreessen Horowitz', ['https://a16z.com/who-gets-paid-when-ai-does-the-shopping', 'https://a16z.com/announcement/investing-in-cognition', 'https://a16z.com/podcast/three-startups-reinventing-critical-infrastructure-2']],
];

const REJECTED: Array<[string, string[]]> = [
  ['McKinsey', ['https://www.mckinsey.com/our-people/lisa-harkness', 'https://www.mckinsey.com/capabilities/people-and-organization/our-insights', 'https://careers.mckinsey.com/jobs/12345']],
  ['BCG', ['https://www.bcg.com/about/people/experts/jeff-walters', 'https://careers.bcg.com/global/en/job/59758/IT-Manager', 'https://web-assets.bcg.com/pdf-src/prod-live/some-report.pdf', 'https://www.bcg.com/publications']],
  ['Bain & Company', ['https://www.bain.com/our-team/tracy-thurkow', 'https://www.bain.com/careers/find-a-role/position', 'https://www.bain.com/insights']],
  ['CFA Institute', ['https://www.cfainstitute.org/insights/events/2026/9th-china-investment-conference', 'https://www.cfainstitute.org/', 'https://blogs.cfainstitute.org/investor/2026/old-style-address']],
  ['Harvard Business Review', ['https://store.hbr.org/product/dei-or-ai-where-to-invest/9077', 'https://hbr.org/topic/subject/marketing']],
  ['MIT Sloan Management Review', ['https://sloanreview.mit.edu/tag/business-risk', 'https://sloanreview.mit.edu/article', 'https://sloanreview.mit.edu/page/10', 'https://sloanreview.mit.edu/topic/managing-technology/page/2']],
  ['BlackRock', ['https://www.blackrock.com/institutions/en-us/investment-capabilities/strategies/equities', 'https://www.blackrock.com/sg/en/literature/prospectus/bgf-singapore-prospectus-sg.pdf', 'https://www.blackrock.com/fi/professionals/products/229725', 'https://www.blackrock.com/be/intermediaries/fr/insights/global-weekly-commentary', 'https://www.blackrock.com/us/financial-professionals/biographies/sam-summers']],
  ['World Economic Forum', ['https://www.weforum.org/organizations/mckinsey-company', 'https://initiatives.weforum.org/global-future-council/home', 'https://www.weforum.org/partners/articles']],
  ['Y Combinator', ['https://news.ycombinator.com/item', 'https://www.ycombinator.com/companies/industry/hardware', 'https://www.ycombinator.com/partners', 'https://www.ycombinator.com/jobs/12345']],
  ['Sequoia Capital', ['https://www.sequoiacap.com/founder/lin-qiao', 'https://sequoiacap.com/companies/unconventional-ai', 'https://jobs.sequoiacap.com/jobs', 'https://sequoiacap.com/jobs']],
  ['Andreessen Horowitz', ['https://a16z.news/p/some-newsletter-post', 'https://jobs.a16z.com/companies/some-startup', 'https://a16z.com/team', 'https://a16z.com/portfolio', 'https://a16z.com/']],
  ['General Catalyst', ['https://jobs.generalcatalyst.com/companies/redesign-health/jobs/64514117-managing-director', 'https://generalcatalyst.com/team/quentin-clark']],
];

test('Scenario: Business and Finance - real article addresses are admitted for each publisher', () => {
  for (const [company, urls] of ADMITTED) {
    for (const url of urls) {
      assert.equal(isApprovedSource(url, SOURCES[company as keyof typeof SOURCES]), true, `${company}: ${url}`);
      assert.equal(looksLikeArticle(url), true, `${company}: ${url}`);
    }
  }
});

test('Scenario: Business and Finance - people, jobs, store, directory, community and locale pages are rejected', () => {
  for (const [company, urls] of REJECTED) {
    for (const url of urls) {
      const passes = isApprovedSource(url, SOURCES[company as keyof typeof SOURCES]) && looksLikeArticle(url);
      assert.equal(passes, false, `${company}: ${url}`);
    }
  }
});

test('an address is only ever admitted for the publisher it belongs to', () => {
  for (const [owner, urls] of ADMITTED) {
    for (const url of urls) {
      for (const company of SOURCE_COMPANIES) {
        if (company === owner) continue;
        assert.equal(isApprovedSource(url, SOURCES[company]), false, `${url} must not count for ${company}`);
      }
    }
  }
});

test('every publisher is searched on its own hosts: the domains sent to Tavily come from the patterns', () => {
  assert.deepEqual(tavilyDomains('CFA Institute'), ['cfainstitute.org', 'rpc.cfainstitute.org']);
  assert.deepEqual(tavilyDomains('World Economic Forum'), ['weforum.org', 'reports.weforum.org']);
  assert.deepEqual(tavilyDomains('Andreessen Horowitz'), ['a16z.com']);
  assert.deepEqual(tavilyDomains('Y Combinator'), ['ycombinator.com']);
});

test('the search wording: the verified one where there is one, otherwise a generic one for the group', () => {
  assert.match(queryFor('NVIDIA'), /^NVIDIA latest research papers, technical blog posts, white papers and product releases about AI$/);
  assert.equal(queryFor('McKinsey'), 'McKinsey latest articles and insights on AI, business, finance and technology');
  assert.equal(queryFor('Andreessen Horowitz'), 'Andreessen Horowitz latest articles and insights on AI, business, finance and technology');
  assert.match(queryFor('CFA Institute'), /^Enterprising Investor CFA Institute blog/);
  assert.match(queryFor('Y Combinator'), /^Y Combinator blog post/);
  for (const company of SOURCE_COMPANIES) assert.ok(queryFor(company).length > 20, company);
});

test('the recency window and result count are the same for the new publishers as for the original seven', async () => {
  for (const company of ['Google', 'McKinsey', 'Y Combinator'] as const) {
    const { fetchFn, sent } = fakeTavily([]);
    await searchCompany(company, { apiKey: KEY, fetchFn });
    const body = JSON.parse(sent[0].init.body as string);
    assert.equal(body.time_range, 'month', company);
    assert.equal(body.max_results, 10, company);
    assert.equal(body.search_depth, 'basic', company);
    assert.equal(body.include_raw_content, 'text', company);
  }
});

