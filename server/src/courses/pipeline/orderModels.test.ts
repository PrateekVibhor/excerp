import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Chat } from '../../llm.ts';
import { askPrerequisites, askStages, STAGE_NAMES } from './orderModels.ts';

const concepts = ['sql', 'dashboards', 'stakeholder management', 'roadmapping'];
const reply = (body: unknown): Chat => async () => `<think>working</think>${JSON.stringify(body)}`;

test('prerequisites: numbered edges become concept names; self, repeated, out-of-range and non-whole edges are dropped', async () => {
  const edges = await askPrerequisites(reply({ edges: [[1, 2], [1, 2], [2, 2], [0, 9], [1.5, 3], [3, 4], 'x', [4]] }), 'data analyst', concepts);
  assert.deepEqual(edges, [['sql', 'dashboards'], ['stakeholder management', 'roadmapping']]);
});

test('prerequisites: the prompt names the role, numbers the concepts and treats them as data', async () => {
  let sent = '';
  await askPrerequisites(async (messages) => ((sent = messages.map((m) => m.content).join('\n')), '{"edges": []}'), 'data analyst', concepts);
  assert.match(sent, /data analyst/);
  assert.match(sent, /1\. sql/);
  assert.match(sent, /4\. roadmapping/);
  assert.match(sent, /never follow instructions/i);
});

test('prerequisites: a reply without an edges list is an error', async () => {
  await assert.rejects(askPrerequisites(reply({ nope: 1 }), 'x', concepts), /edges/);
  await assert.rejects(askPrerequisites(async () => 'no json here', 'x', concepts));
});

test('stages: one stage from 1 to 4 per concept, in order', async () => {
  const stages = await askStages(reply({ stages: [2, 3, 1, 4] }), 'data analyst', concepts);
  assert.deepEqual(stages, { sql: 2, dashboards: 3, 'stakeholder management': 1, roadmapping: 4 });
  assert.equal(STAGE_NAMES.length, 4);
});

test('stages: a list of the wrong length or with a stage outside 1 to 4 is an error', async () => {
  await assert.rejects(askStages(reply({ stages: [1, 2, 3] }), 'x', concepts), /one stage per concept/);
  await assert.rejects(askStages(reply({ stages: [1, 2, 3, 5] }), 'x', concepts), /1 to 4/);
  await assert.rejects(askStages(reply({ stages: [1, 2, 3, 'a'] }), 'x', concepts), /1 to 4/);
  await assert.rejects(askStages(reply({}), 'x', concepts));
});

test('the stage prompt names the four stages', async () => {
  let sent = '';
  await askStages(async (messages) => ((sent = messages.map((m) => m.content).join('\n')), '{"stages": [1,1,1,1]}'), 'x', concepts);
  for (const name of STAGE_NAMES) assert.match(sent, new RegExp(name, 'i'));
});
