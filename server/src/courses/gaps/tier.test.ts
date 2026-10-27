// Source finder: a suggested tier, layer and perspective from who publishes the page. A suggestion only; the page still has to pass the checks.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { suggestTier, finderDenied } from './tier.ts';

test('standards bodies, government and universities are tier 1, institutional and canonical', () => {
  for (const url of ['https://www.iiba.org/business-analysis-body-of-knowledge/', 'https://www.nist.gov/itl/ai-risk', 'https://cs.stanford.edu/notes/sql.pdf', 'https://www.pmi.org/learning/library/x', 'https://www.omg.org/spec/BPMN/2.0/']) {
    assert.deepEqual(suggestTier(url), { tier: 1, layer: 'institutional', perspective: 'canonical' }, url);
  }
});

test('official vendor documentation is tier 2, practical, field', () => {
  for (const url of ['https://learn.microsoft.com/en-us/sql/t-sql/', 'https://support.microsoft.com/en-us/office/pivot-tables', 'https://www.atlassian.com/agile/project-management', 'https://docs.snowflake.com/en/sql-reference', 'https://cloud.google.com/bigquery/docs']) {
    assert.deepEqual(suggestTier(url), { tier: 2, layer: 'practical', perspective: 'field' }, url);
  }
});

test('anything else is tier 3, and a lookalike domain is not mistaken for an institution', () => {
  assert.deepEqual(suggestTier('https://someblog.example.com/post'), { tier: 3, layer: 'practical', perspective: 'field' });
  assert.equal(suggestTier('https://nist.gov.evil-example.com/page').tier, 3);
  assert.equal(suggestTier('https://notiiba.org/page').tier, 3);
});

test('job boards, staffing sites, social posts and forums are never used as sources', () => {
  for (const url of ['https://www.linkedin.com/posts/x', 'https://uk.indeed.com/viewjob', 'https://www.reddit.com/r/x', 'https://medium.com/@x/post', 'https://www.quora.com/q', 'https://www.roberthalf.com/jobs', 'https://www.youtube.com/watch?v=1', 'https://www.facebook.com/x']) {
    assert.equal(finderDenied(url) !== null, true, url);
  }
  assert.equal(finderDenied('https://www.iiba.org/x'), null);
  assert.equal(finderDenied('not a url'), 'not a web address');
});

test('job descriptions, careers pages, interview-question lists and course sales pages are not sources, wherever they are hosted', () => {
  for (const url of [
    'https://spotterful.com/en/blog/job-description-template/erp-business-analyst-responsibilities-and-required-skills', 'https://jobs.citi.com/job/tampa/data-engineering-lead/1',
    'https://x.example.org/careers/analyst', 'https://thebusinessanalystjobdescription.com/uat-interview-questions-for-business-analyst', 'https://www.udacity.com/course/sql-for-data-analysis--ud198',
    'https://alison.com/course/excel-for-business-analysts', 'https://www.datacamp.com/tracks/sql-for-business-analysts', 'https://x.example.org/bootcamp/data', 'https://x.example.org/pricing',
  ]) assert.notEqual(finderDenied(url), null, url);
  for (const url of ['https://trailhead.salesforce.com/content/learn/modules/user-acceptance-testing-video/learn-about-user-acceptance-testing', 'https://www.atlassian.com/agile/project-management/status-report', 'https://online.hbs.edu/documents/a-beginners-guide-to-data-and-analytics.pdf']) {
    assert.equal(finderDenied(url), null, url);
  }
});
