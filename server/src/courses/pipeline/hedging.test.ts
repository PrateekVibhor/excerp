import assert from 'node:assert/strict';
import { test } from 'node:test';
import { hedgeRate, isTooVague } from './chapters.ts';

const concrete = 'Sam reproduced the failure in staging, read the stack trace, found the missing index and added it. The query dropped from four seconds to forty milliseconds. Then Sam wrote a test that failed without the index.';
const vague = 'Debugging may often help in some cases. It could sometimes be useful, and results can vary. Teams generally might find that it depends, and typically things usually improve to some extent.';

test('hedge words are counted per hundred words', () => {
  assert.equal(hedgeRate('It may work.'), (1 / 3) * 100);
  assert.equal(hedgeRate(concrete), 0);
  assert.ok(hedgeRate(vague) > 15);
});

test('text that is mostly hedges is too vague; concrete text is not', () => {
  assert.equal(isTooVague(vague), true);
  assert.equal(isTooVague(concrete), false);
});

test('a little honest hedging is fine: one "may" in a concrete paragraph is not vague', () => {
  assert.equal(isTooVague(`${concrete} The fix may not apply on older versions.`), false);
});

test('vagueness is judged on hedge density and on the lack of anything specific, not on the hedge words alone', () => {
  const noSpecifics = 'This is important. It matters in practice. Teams care about it a lot. It is useful to know about it and to think about how it fits with the rest of the work they do.';
  assert.equal(isTooVague(noSpecifics), true); // no hedges at all, but nothing concrete either
});

test('technical wording counts as specific even in lower case: slashes, hyphens, acronyms and numbers', () => {
  const technical = 'You set up a ci/cd pipeline so every commit to the main branch triggers a build, and you follow trunk-based development with tiny commits. Each deploy ships a container image behind a load balancer and watches the p99 latency for ten minutes before it widens the rollout.';
  assert.equal(isTooVague(technical), false);
});
