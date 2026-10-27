import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CONTENT_TYPES, SOURCE_COMPANIES } from '../../src/data/types.ts';
import { BUSINESS_TYPES, isTechCompany, loadConfig, SEARCH_QUERIES, SOURCES, TAGS, TECH_TYPES, tavilyDomains } from './config.ts';

const complete = {
  TAVILY_API_KEY: 'tvly-secret-value',
  NEBIUS_API_KEY: 'nebius-secret-value',
  NEBIUS_MODEL: 'nvidia/nemotron-3-super-120b-a12b',
  DATABASE_URL: 'postgres://localhost:5432/swipy',
};

test('loads a complete environment with the agreed defaults', () => {
  const config = loadConfig(complete);
  assert.equal(config.nebiusModel, 'nvidia/nemotron-3-super-120b-a12b');
  assert.equal(config.runIntervalMinutes, 1440);
  assert.equal(config.maxPerCompany, 3);
  assert.equal(config.port, 8080);
  assert.deepEqual(config.trustProxy, []); // nothing is trusted unless TRUST_PROXY says so
});

test('names every missing variable', () => {
  assert.throws(() => loadConfig({ DATABASE_URL: 'postgres://x' }), {
    message: 'Missing environment variables: TAVILY_API_KEY, NEBIUS_API_KEY, NEBIUS_MODEL',
  });
});

test('treats a blank value as missing', () => {
  assert.throws(() => loadConfig({ ...complete, NEBIUS_API_KEY: '   ' }), /NEBIUS_API_KEY/);
});

test('never puts a secret value in an error message', () => {
  for (const env of [
    { ...complete, MAX_PER_COMPANY: 'lots' },
    { ...complete, RUN_INTERVAL_MINUTES: '-5' },
    { ...complete, NEBIUS_MODEL: '' },
  ]) {
    try {
      loadConfig(env);
      assert.fail('expected an error');
    } catch (error) {
      const message = (error as Error).message;
      assert.ok(!message.includes('tvly-secret-value'), message);
      assert.ok(!message.includes('nebius-secret-value'), message);
    }
  }
});

test('rejects a cap or interval that is not a positive whole number', () => {
  assert.throws(() => loadConfig({ ...complete, MAX_PER_COMPANY: '0' }), /MAX_PER_COMPANY/);
  assert.throws(() => loadConfig({ ...complete, RUN_INTERVAL_MINUTES: '1.5' }), /RUN_INTERVAL_MINUTES/);
});

test('has source patterns for every target company, as host[/path] with no scheme', () => {
  for (const company of SOURCE_COMPANIES) {
    const patterns = SOURCES[company];
    assert.ok(patterns.length > 0, company);
    for (const pattern of patterns) assert.match(pattern, /^[a-z0-9.-]+\.[a-z]+(\/[a-z0-9*-]+)*$/, `${company}: ${pattern}`);
  }
});

test('gives Tavily each company\'s hosts once', () => {
  assert.deepEqual(tavilyDomains('NVIDIA'), ['blogs.nvidia.com', 'developer.nvidia.com', 'nvidianews.nvidia.com', 'research.nvidia.com']);
  assert.deepEqual(tavilyDomains('AWS'), ['aws.amazon.com']);
  // A bare microsoft.com would let Tavily search learn, docs and technet too.
  assert.ok(tavilyDomains('Microsoft').includes('www.microsoft.com'));
  assert.ok(!tavilyDomains('Microsoft').includes('microsoft.com'));
  for (const company of SOURCE_COMPANIES) {
    const hosts = tavilyDomains(company);
    assert.equal(new Set(hosts).size, hosts.length, company);
  }
});

const TECH_COMPANIES = ['NVIDIA', 'Google', 'Meta', 'OpenAI', 'Anthropic', 'AWS', 'Microsoft'] as const;
const BUSINESS_SOURCES = SOURCE_COMPANIES.filter((c) => !(TECH_COMPANIES as readonly string[]).includes(c));

test('Scenario: Business and Finance - the twelve publishers sit alongside the seven companies', () => {
  assert.equal(SOURCE_COMPANIES.length, 19);
  assert.deepEqual([...SOURCE_COMPANIES.slice(0, 7)], [...TECH_COMPANIES]); // the original seven keep their place
  assert.deepEqual(
    [...BUSINESS_SOURCES].sort(),
    ['Andreessen Horowitz', 'BCG', 'Bain & Company', 'BlackRock', 'CFA Institute', 'General Catalyst', 'Harvard Business Review', 'MIT Sloan Management Review', 'McKinsey', 'Sequoia Capital', 'World Economic Forum', 'Y Combinator'].sort(),
  );
});

test('every pattern is an exact host with a path at most: no scheme, no wildcard host, no bare TLD', () => {
  for (const company of SOURCE_COMPANIES) {
    for (const pattern of SOURCES[company]) {
      const host = pattern.split('/')[0];
      assert.ok(!/^[a-z]+:\/\//i.test(pattern), `${company}: ${pattern} has a scheme`);
      assert.ok(!host.includes('*'), `${company}: ${pattern} has a wildcard host`);
      assert.match(host, /^[a-z0-9-]+(\.[a-z0-9-]+)+$/, `${company}: ${pattern}`);
      assert.ok(host.split('.').length >= 2, `${company}: ${pattern}`);
    }
  }
});

test('the hosts that belong to the new publishers', () => {
  const hosts = (c: (typeof SOURCE_COMPANIES)[number]) => tavilyDomains(c);
  assert.deepEqual(hosts('McKinsey'), ['mckinsey.com']);
  assert.deepEqual(hosts('BCG'), ['bcg.com']);
  assert.deepEqual(hosts('Bain & Company'), ['bain.com']);
  assert.deepEqual(hosts('CFA Institute'), ['cfainstitute.org', 'rpc.cfainstitute.org']);
  assert.deepEqual(hosts('Harvard Business Review'), ['hbr.org']);
  assert.deepEqual(hosts('MIT Sloan Management Review'), ['sloanreview.mit.edu']);
  assert.deepEqual(hosts('BlackRock'), ['blackrock.com']);
  assert.deepEqual(hosts('World Economic Forum'), ['weforum.org', 'reports.weforum.org']);
  assert.deepEqual(hosts('Y Combinator'), ['ycombinator.com']);
  assert.deepEqual(hosts('Sequoia Capital'), ['sequoiacap.com']);
  assert.deepEqual(hosts('Andreessen Horowitz'), ['a16z.com']);
  assert.deepEqual(hosts('General Catalyst'), ['generalcatalyst.com']);
});

test('no host is claimed by two publishers, so an article can only ever belong to one', () => {
  const owner = new Map<string, string>();
  for (const company of SOURCE_COMPANIES) {
    for (const pattern of SOURCES[company]) {
      const key = pattern.replace(/^www\./, '');
      const [host, ...path] = key.split('/');
      const id = `${host}/${path.join('/')}`;
      assert.equal(owner.get(id) ?? company, company, `${pattern} is listed for ${owner.get(id)} and ${company}`);
      owner.set(id, company);
    }
  }
});

test('Scenario: Business tags - Consulting for McKinsey, BCG and Bain; Finance for CFA Institute and BlackRock', () => {
  for (const company of ['McKinsey', 'BCG', 'Bain & Company'] as const) assert.deepEqual(TAGS[company], { fixed: 'Consulting' }, company);
  for (const company of ['CFA Institute', 'BlackRock'] as const) assert.deepEqual(TAGS[company], { fixed: 'Finance' }, company);
});

test('Scenario: Business tags - Venture Capital for Y Combinator, Sequoia, Andreessen Horowitz and General Catalyst', () => {
  for (const company of ['Y Combinator', 'Sequoia Capital', 'Andreessen Horowitz', 'General Catalyst'] as const)
    assert.deepEqual(TAGS[company], { fixed: 'Venture Capital' }, company);
});

test('Scenario: Business tags - HBR, MIT SMR and the World Economic Forum are tagged from each article\'s content', () => {
  for (const company of ['Harvard Business Review', 'MIT Sloan Management Review', 'World Economic Forum'] as const) {
    const rule = TAGS[company];
    assert.ok('choose' in rule, company);
    assert.deepEqual([...('choose' in rule ? rule.choose : [])], ['Consulting', 'Finance', 'Venture Capital'], company);
  }
});

test('the seven tech companies keep choosing among their four types, and never get a business one', () => {
  for (const company of TECH_COMPANIES) {
    const rule = TAGS[company];
    assert.ok('choose' in rule && rule.choose === TECH_TYPES, company);
    assert.equal(isTechCompany(company), true, company);
  }
  for (const company of BUSINESS_SOURCES) assert.equal(isTechCompany(company), false, company);
});

test('every source has exactly one tag rule, and every tag it can produce is a known content type', () => {
  assert.deepEqual(Object.keys(TAGS).sort(), [...SOURCE_COMPANIES].sort());
  for (const company of SOURCE_COMPANIES) {
    const rule = TAGS[company];
    const types = 'fixed' in rule ? [rule.fixed] : [...rule.choose];
    assert.ok(types.length > 0, company);
    for (const type of types) assert.ok((CONTENT_TYPES as readonly string[]).includes(type), `${company}: ${type}`);
  }
  assert.deepEqual([...TECH_TYPES, ...BUSINESS_TYPES].sort(), [...CONTENT_TYPES].sort());
});

test('a search wording is only overridden for a source that has one, and each names its publisher', () => {
  for (const [company, query] of Object.entries(SEARCH_QUERIES)) {
    assert.ok((SOURCE_COMPANIES as readonly string[]).includes(company), company);
    assert.match(query!, /Sloan|Enterprising Investor|BlackRock|Y Combinator|Sequoia|General Catalyst/, company);
  }
});


test('TRUST_PROXY is a comma-separated list of addresses; blanks are dropped', () => {
  assert.deepEqual(loadConfig({ ...complete, TRUST_PROXY: ' 172.30.0.10 , ,10.0.0.0/8 ' }).trustProxy, ['172.30.0.10', '10.0.0.0/8']);
  assert.deepEqual(loadConfig({ ...complete, TRUST_PROXY: '' }).trustProxy, []);
});

test('GOOGLE_WEB_CLIENT_ID turns Google sign-in on; left out or blank it is off', () => {
  assert.equal(loadConfig(complete).googleWebClientId, undefined);
  assert.equal(loadConfig({ ...complete, GOOGLE_WEB_CLIENT_ID: '   ' }).googleWebClientId, undefined);
  assert.equal(loadConfig({ ...complete, GOOGLE_WEB_CLIENT_ID: ' web.apps.googleusercontent.com ' }).googleWebClientId, 'web.apps.googleusercontent.com');
});

test('Apple sign-in: the bundle id is the app\'s unless set; the team id, key id and key (contents or a path) are read only from the environment and are all optional', () => {
  const c = loadConfig(complete);
  assert.equal(c.appleBundleId, 'com.prateekvibhor.excerp');
  assert.deepEqual([c.appleTeamId, c.appleKeyId, c.applePrivateKey, c.applePrivateKeyPath], [undefined, undefined, undefined, undefined]);
  const set = loadConfig({ ...complete, APPLE_BUNDLE_ID: ' com.example.app ', APPLE_TEAM_ID: ' TEAM1 ', APPLE_KEY_ID: 'KEY1', APPLE_PRIVATE_KEY: '-----BEGIN PRIVATE KEY-----\\nabc\\n-----END PRIVATE KEY-----', APPLE_PRIVATE_KEY_PATH: ' /run/secrets/apple.p8 ' });
  assert.equal(set.appleBundleId, 'com.example.app');
  assert.equal(set.appleTeamId, 'TEAM1');
  assert.equal(set.appleKeyId, 'KEY1');
  assert.equal(set.applePrivateKey, '-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----', 'a key written on one line with \\n gets its real line breaks');
  assert.equal(set.applePrivateKeyPath, '/run/secrets/apple.p8');
  assert.equal(loadConfig({ ...complete, APPLE_TEAM_ID: '  ', APPLE_PRIVATE_KEY: ' ' }).appleTeamId, undefined);
  assert.equal(loadConfig({ ...complete, APPLE_PRIVATE_KEY: ' ' }).applePrivateKey, undefined);
});

test('ALLOW_ANY_GOOGLE_ACCOUNT is off unless it is switched on', () => {
  assert.equal(loadConfig(complete).allowAnyGoogleAccount, false);
  assert.equal(loadConfig({ ...complete, ALLOW_ANY_GOOGLE_ACCOUNT: '' }).allowAnyGoogleAccount, false);
  assert.equal(loadConfig({ ...complete, ALLOW_ANY_GOOGLE_ACCOUNT: 'false' }).allowAnyGoogleAccount, false);
  assert.equal(loadConfig({ ...complete, ALLOW_ANY_GOOGLE_ACCOUNT: 'true' }).allowAnyGoogleAccount, true);
  assert.equal(loadConfig({ ...complete, ALLOW_ANY_GOOGLE_ACCOUNT: '1' }).allowAnyGoogleAccount, true);
  assert.throws(() => loadConfig({ ...complete, ALLOW_ANY_GOOGLE_ACCOUNT: 'yes please' }), /ALLOW_ANY_GOOGLE_ACCOUNT/); // a typo must not silently leave access open or closed
});


test('the scheduled list-course refresh is off unless LIST_REFRESH_MINUTES is set, then takes a positive whole number of minutes, and "off" says it again', () => {
  assert.equal(loadConfig(complete).listRefreshMinutes, undefined);
  assert.equal(loadConfig({ ...complete, LIST_REFRESH_MINUTES: '  ' }).listRefreshMinutes, undefined);
  assert.equal(loadConfig({ ...complete, LIST_REFRESH_MINUTES: '60' }).listRefreshMinutes, 60);
  assert.equal(loadConfig({ ...complete, LIST_REFRESH_MINUTES: '30' }).listRefreshMinutes, 30);
  for (const off of ['off', 'OFF', ' Off ']) assert.equal(loadConfig({ ...complete, LIST_REFRESH_MINUTES: off }).listRefreshMinutes, undefined, off);
  for (const bad of ['0', '-5', 'hourly', '1.5']) assert.throws(() => loadConfig({ ...complete, LIST_REFRESH_MINUTES: bad }), /LIST_REFRESH_MINUTES must be a positive whole number/);
});

test('the example environment file names the scheduled refresh, commented out so it stays off by default', async () => {
  const { readFileSync } = await import('node:fs');
  const example = readFileSync(new URL('../.env.example', import.meta.url), 'utf8');
  assert.match(example, /^# LIST_REFRESH_MINUTES=\d+$/m);
  assert.doesNotMatch(example, /^LIST_REFRESH_MINUTES=/m);
});

test('the course runner is off unless COURSE_RUNNER_SECONDS is set, and then takes a positive whole number of seconds', () => {
  assert.equal(loadConfig(complete).courseRunnerSeconds, undefined);
  assert.equal(loadConfig({ ...complete, COURSE_RUNNER_SECONDS: '  ' }).courseRunnerSeconds, undefined);
  assert.equal(loadConfig({ ...complete, COURSE_RUNNER_SECONDS: '15' }).courseRunnerSeconds, 15);
  for (const bad of ['0', '-5', 'often', '1.5']) assert.throws(() => loadConfig({ ...complete, COURSE_RUNNER_SECONDS: bad }), /COURSE_RUNNER_SECONDS must be a positive whole number/);
});

test('each course run has a search-credit budget, 20 to find sources and 40 to build, so one course costs at most 60 unless changed', () => {
  const c = loadConfig(complete);
  assert.deepEqual([c.courseFindCredits, c.courseBuildCredits], [20, 40]);
  const own = loadConfig({ ...complete, COURSE_FIND_CREDITS: '8', COURSE_BUILD_CREDITS: '25' });
  assert.deepEqual([own.courseFindCredits, own.courseBuildCredits], [8, 25]);
  for (const bad of ['0', '-1', 'lots']) assert.throws(() => loadConfig({ ...complete, COURSE_BUILD_CREDITS: bad }), /COURSE_BUILD_CREDITS must be a positive whole number/);
});

test('the example environment file names the course runner and its budgets, commented out so they stay at their defaults', async () => {
  const { readFileSync } = await import('node:fs');
  const example = readFileSync(new URL('../.env.example', import.meta.url), 'utf8');
  for (const name of ['COURSE_RUNNER_SECONDS', 'COURSE_FIND_CREDITS', 'COURSE_BUILD_CREDITS']) {
    assert.match(example, new RegExp(`^# ${name}=\\d+$`, 'm'), name);
    assert.doesNotMatch(example, new RegExp(`^${name}=`, 'm'), name);
  }
});

test('a separate, smaller model for judging web pages is optional and off unless named', () => {
  assert.equal(loadConfig(complete).nebiusJudgeModel, undefined);
  assert.equal(loadConfig({ ...complete, NEBIUS_JUDGE_MODEL: ' meta/small-8b ' }).nebiusJudgeModel, 'meta/small-8b');
  assert.equal(loadConfig({ ...complete, NEBIUS_JUDGE_MODEL: '' }).nebiusJudgeModel, undefined);
});
