import assert from 'node:assert/strict';
import { test } from 'node:test';
import { durationSeconds, screenVideo, type VideoMeta } from './videoScreen.ts';

const now = new Date('2026-10-15T00:00:00Z');
const good: VideoMeta = { id: 'abc', title: 'How we debug a production outage', channel: 'Some Engineer', channelId: 'c1', publishedAt: '2025-06-01T00:00:00Z', duration: 'PT24M10S', views: 40_000, likes: 1_800, captions: true, language: 'en' };

test('ISO 8601 durations become seconds', () => {
  assert.equal(durationSeconds('PT24M10S'), 1450);
  assert.equal(durationSeconds('PT1H2M'), 3720);
  assert.equal(durationSeconds('PT45S'), 45);
  assert.equal(durationSeconds('P0D'), 0);
});

test('a recent, mid-length, captioned, well-liked video is kept', () => {
  assert.deepEqual(screenVideo(good, now), { keep: true, reasons: [] });
});

test('each rule rejects with its own reason', () => {
  const reasons = (patch: Partial<VideoMeta>) => screenVideo({ ...good, ...patch }, now).reasons;
  assert.deepEqual(reasons({ duration: 'PT55S' }), ['too short']);
  assert.deepEqual(reasons({ duration: 'PT3H' }), ['too long']);
  assert.deepEqual(reasons({ publishedAt: '2020-01-01T00:00:00Z' }), ['too old']);
  assert.deepEqual(reasons({ views: 2_999 }), ['too few views']);
  assert.deepEqual(reasons({ likes: 49 }), ['too few likes']);
  assert.deepEqual(reasons({ captions: false }), ['no captions']);
  assert.deepEqual(reasons({ language: 'de' }), ['not English']);
  assert.deepEqual(reasons({ title: 'YOU WONT BELIEVE THIS DEBUGGING TRICK' }), ['clickbait title']);
});

test('views and likes are checked independently, each against its own raw number', () => {
  assert.deepEqual(screenVideo({ ...good, views: 300, likes: 20 }, now).reasons.sort(), ['too few likes', 'too few views']);
});

test('the thresholds are inclusive: exactly 3,000 views and 50 likes is kept', () => {
  assert.equal(screenVideo({ ...good, views: 3_000, likes: 50 }, now).keep, true);
});

test('there is no ratio rule: a huge video with few likes per view is kept if both raw numbers pass', () => {
  assert.equal(screenVideo({ ...good, views: 5_000_000, likes: 60 }, now).keep, true);
});

test('a video with no stated language is not rejected for language', () => {
  assert.equal(screenVideo({ ...good, language: undefined }, now).keep, true);
});

test('several failed rules are all listed', () => {
  assert.deepEqual(screenVideo({ ...good, captions: false, duration: 'PT30S' }, now).reasons.sort(), ['no captions', 'too short']);
});
