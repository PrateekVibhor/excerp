import assert from 'node:assert/strict';
import { test } from 'node:test';
import { denylistReason, employerOf, isAggregator, isLegitimateSource, looksLikePosting, matchTitle, rankSkills, stripEqualOpportunity } from './matching.ts';

const seed = [
  { employer: 'Citi', domains: ['jobs.citi.com'] },
  { employer: 'Palantir', domains: ['palantir.com', 'jobs.lever.co'] },
  { employer: 'Anthropic', domains: ['anthropic.com', 'job-boards.greenhouse.io'] },
];

test('a seed company is recognised by its domain', () => {
  assert.equal(employerOf('https://jobs.citi.com/job/new-york/analyst/287/1', seed), 'Citi');
});

test('a shared application system is split by the company in the path', () => {
  assert.equal(employerOf('https://jobs.lever.co/palantir/abc-123', seed), 'Palantir');
  assert.equal(employerOf('https://job-boards.greenhouse.io/anthropic/jobs/42', seed), 'Anthropic');
  assert.equal(employerOf('https://jobs.lever.co/acme-corp/abc-123', seed), 'acme-corp');
});

test('an unknown domain is named by its host', () => {
  assert.equal(employerOf('https://careers.example.com/jobs/1', seed), 'example.com');
});

test('job boards and aggregators are recognised', () => {
  for (const url of ['https://www.indeed.com/viewjob?jk=1', 'https://www.linkedin.com/jobs/view/1', 'https://www.glassdoor.com/job/1'])
    assert.equal(isAggregator(url), true, url);
  assert.equal(isAggregator('https://jobs.citi.com/job/1'), false);
});

test('title matching: the role with a level or a team after it is exact', () => {
  for (const t of ['Product Manager', 'Senior Product Manager', 'Product Manager, Payments', 'Product Manager - New York, NY', 'Product Manager II', 'Sr. Product Manager (Remote)'])
    assert.equal(matchTitle('product manager', [], t), 'exact', t);
});

test('title matching: a known alias counts', () => {
  assert.equal(matchTitle('forward-deployed engineer', ['frontier deployed engineer'], 'Frontier Deployed Engineer, Finance'), 'alias');
  assert.equal(matchTitle('forward-deployed engineer', [], 'Forward Deployed Engineer'), 'exact');
});

test('title matching: a title that only resembles the role is similar and one that does not is no', () => {
  assert.equal(matchTitle('product manager', [], 'Technical Product Manager'), 'similar');
  assert.equal(matchTitle('product manager', [], 'Product Marketing Manager'), 'similar');
  assert.equal(matchTitle('product manager', [], 'Project Manager'), 'no');
  assert.equal(matchTitle('product manager', [], 'Software Engineer'), 'no');
});

test('equal-opportunity sentences are removed and the rest is kept', () => {
  const text = 'You will own SQL reporting. We are an equal opportunity employer and do not discriminate on the basis of race. You will manage stakeholders.';
  const out = stripEqualOpportunity(text);
  assert.match(out, /SQL reporting/);
  assert.match(out, /manage stakeholders/);
  assert.doesNotMatch(out, /equal opportunity|race/i);
});

test('skills are ranked by the share of postings, counted once per posting', () => {
  const postings = Array.from({ length: 11 }, (_, i) => ({
    skills: [
      ...(i < 9 ? ['SQL', 'sql'] : []), // nine postings, one repeating itself
      ...(i < 2 ? ['Roadmapping'] : []),
      ...(i === 0 ? ['Origami'] : []),
    ],
  }));
  const ranked = rankSkills(postings);
  const by = Object.fromEntries(ranked.map((r) => [r.skill, r]));
  assert.deepEqual([by.sql.mentions, by.sql.of, by.sql.band], [9, 11, 'high']);
  assert.deepEqual([by.roadmapping.mentions, by.roadmapping.band], [2, 'low']);
  assert.equal(by.origami, undefined, 'a skill mentioned once is dropped');
});

test('the bands meet at their edges', () => {
  const make = (n: number) => rankSkills(Array.from({ length: 100 }, (_, i) => ({ skills: i < n ? ['x'] : [] })))[0].band;
  assert.equal(make(60), 'high');
  assert.equal(make(59), 'medium');
  assert.equal(make(25), 'medium');
  assert.equal(make(24), 'low');
});

test('a posting has duties and requirements and is long enough; a careers hub or a blog does not', () => {
  const posting = `About the role. You will own the roadmap. Responsibilities include planning. Qualifications: 5 years. ${'Details. '.repeat(200)}`;
  assert.equal(looksLikePosting('https://jobs.example.com/job/123', posting), true);
  assert.equal(looksLikePosting('https://jobs.example.com/job/123', 'Apply now. Short stub.'), false);
  assert.equal(looksLikePosting('https://example.com/careers', posting), false, 'a careers landing page');
  assert.equal(looksLikePosting('https://example.com/jobs/search/', posting), false, 'a search results page');
  assert.equal(looksLikePosting('https://example.com/blog/what-does-a-pm-do', `${'Words about the job. '.repeat(200)}`), false, 'no duties or requirements');
});

test('an article about the role is not a posting even when it mentions duties', () => {
  const body = `Responsibilities and qualifications explained. ${'Advice. '.repeat(300)}`;
  assert.equal(looksLikePosting('https://example.com/agile/product-manager', body, 'Product Manager: Role & Best Practices for Beginners'), false);
  assert.equal(looksLikePosting('https://example.com/pm', body, 'What Does a Product Manager Do?'), false);
  assert.equal(looksLikePosting('https://example.com/job/1', body, 'Senior Product Manager, Payments'), true);
});

test('a dash followed by a space starts the team or programme, however it is spaced', () => {
  assert.equal(matchTitle('business analyst', [], 'Senior Business Analyst- PULSE - Global Payment Network'), 'exact');
  assert.equal(matchTitle('product manager', [], 'Product Manager– Payments'), 'exact');
});

test('the denylist blocks boards, template sites and staffing agencies outright, whatever the path looks like', () => {
  assert.equal(denylistReason('https://www.betterteam.com/product-manager-job-description'), 'template');
  assert.equal(denylistReason('https://remoterocketship.com/company/acme/jobs/product-manager/'), 'aggregator');
  assert.equal(denylistReason('https://www.randstadusa.com/jobs/search/4/12345/product-manager/'), 'staffing');
  assert.equal(denylistReason('https://fdepulse.com/jobs/frontier-agents-engineer'), 'aggregator');
  assert.equal(denylistReason('https://www.lhh.com/us/en/jobs/1'), 'staffing');
  assert.equal(denylistReason('https://sub.indeed.com/viewjob?jk=1'), 'aggregator');
  assert.equal(denylistReason('https://jobs.citi.com/job/1'), null);
  assert.equal(isAggregator('https://www.betterteam.com/x'), true, 'isAggregator is the same check');
});

test('only an employer\'s own career page or an official application system is a legitimate source', () => {
  assert.equal(isLegitimateSource('https://jobs.citi.com/job/new-york/analyst/287/1', seed), true, 'a seed company');
  assert.equal(isLegitimateSource('https://boards.greenhouse.io/acme/jobs/1', seed), true, 'an application system');
  assert.equal(isLegitimateSource('https://citi.wd5.myworkdayjobs.com/en-US/External/job/x_R1', seed), true, 'an application system');
  assert.equal(isLegitimateSource('https://careers.example.com/jobs/1', seed), true, 'a careers subdomain');
  assert.equal(isLegitimateSource('https://www.example.com/careers/open-roles/analyst', seed), true, 'a careers path on a company site');
  assert.equal(isLegitimateSource('https://komatsu.jobs/job/1', seed), true, 'a .jobs company site');
  assert.equal(isLegitimateSource('https://www.betterteam.com/careers/job-description', seed), false, 'denylisted');
  assert.equal(isLegitimateSource('https://compliance-officer.org/blog/what-is', seed), false, 'an information site');
  assert.equal(isLegitimateSource('https://www.randstadusa.com/careers/jobs/1', seed), false, 'a staffing agency');
});

test('employers on a hosted application system are named by their subdomain', () => {
  assert.equal(employerOf('https://citi.wd5.myworkdayjobs.com/en-US/External/job/x', seed), 'Citi');
  assert.equal(employerOf('https://acme.wd1.myworkdayjobs.com/en-US/External/job/x', seed), 'acme');
});

test('titles that put the specialty after the job, or wrap the title in page text, still match', () => {
  const role = 'backend software engineer';
  const aliases = ['backend engineer', 'back end engineer', 'software engineer backend'];
  for (const title of [
    'Software Engineer, Backend | Plaid',
    'Stripe Careers | Backend Engineer, Core Technology',
    'Job Application for Senior Backend Software Engineer at Otter',
    'Senior Software Engineer (Backend)',
    'Staff Software Engineer - Backend - United States',
    'Software Engineer: Backend | Thatch Careers',
  ])
    assert.ok(['exact', 'alias'].includes(matchTitle(role, aliases, title)), title);
  assert.equal(matchTitle(role, aliases, 'Software Engineer, Full Stack | Plaid'), 'no');
  assert.equal(matchTitle(role, aliases, 'Backend Software Development Engineer - Mid/Senior'), 'similar');
});

test('a job-description template is not a posting even on a company site', () => {
  const body = `Responsibilities and requirements. ${'Text. '.repeat(400)}`;
  assert.equal(looksLikePosting('https://www.deel.com/resources/bi-analyst', body, 'Business Intelligence Analyst Job Description'), false);
  assert.equal(looksLikePosting('https://www.deel.com/resources/bi-analyst', body, 'Software Engineer Job Description Template'), false);
});

test('hosts that say careers or jobs, and careers paths at any depth, are legitimate', () => {
  assert.equal(isLegitimateSource('https://www.kpmguscareers.com/jobdetails/?jobId=1', seed), true);
  assert.equal(isLegitimateSource('https://www.pepsicojobs.com/main/jobs/1', seed), true);
  assert.equal(isLegitimateSource('https://www.example.com/en/us/company/careers/open/1', seed), true);
});

test('an application system\'s own site is not a posting, only its customers\' subdomains are', () => {
  assert.equal(isLegitimateSource('https://breezy.hr/resources/job-descriptions/data-analyst', seed), false);
  assert.equal(isLegitimateSource('https://acme.breezy.hr/p/abc-financial-advisor', seed), true);
  assert.equal(looksLikePosting('https://acme.com/resources/job-descriptions/analyst', `Responsibilities and requirements. ${'Text. '.repeat(400)}`, 'Data Analyst'), false);
});

test('hiring platforms are denylisted, including one account on a shared application system', () => {
  assert.equal(denylistReason('https://jobs.wizehire.com/job/entry-level-financial-advisor'), 'staffing');
  assert.equal(denylistReason('https://apply.workable.com/weekday-1/j/C96174D6F9'), 'staffing');
  assert.equal(denylistReason('https://apply.workable.com/acme/j/C96174D6F9'), null);
});

test('regional job-board sites, résumé sites, user-made sites and sandbox boards are refused', () => {
  for (const url of [
    'https://www.builtinsf.com/job/senior-cloud-finops-analyst/7429733',
    'https://www.builtincolorado.com/job/ai-value-specialist/8337913',
    'https://earnbetter.com/app/job/01M2X11PVKK90PCQKC54G0TG2S',
    'https://sites.google.com/view/data-analyst32745/home',
    'https://www.oficareers.com/jobs/17740417-business-analyst',
    'https://boards.greenhouse.io/mergeapiintegrationsandbox/jobs/7683634003',
  ])
    assert.equal(isLegitimateSource(url, seed), false, url);
  assert.equal(isLegitimateSource('https://boards.greenhouse.io/acme/jobs/1', seed), true);
});

test('jobs deep in a path do not make a site an employer\'s career page, careers still do', () => {
  assert.equal(isLegitimateSource('https://www.example.com/en/us/company/careers/open/1', seed), true);
  assert.equal(isLegitimateSource('https://www.example.com/news/2026/jobs-report', seed), false);
});
