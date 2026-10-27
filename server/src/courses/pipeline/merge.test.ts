import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mergeSkillNames } from './merge.ts';

const fake = (groups: object) => async () => JSON.stringify({ groups });

test('names the model groups become one, and names it leaves alone stay as they are', async () => {
  const map = await mergeSkillNames(fake([{ name: 'sql', variants: ['writing sql queries', 'sql querying'] }]), ['sql', 'writing sql queries', 'sql querying', 'roadmapping']);
  assert.equal(map['writing sql queries'], 'sql');
  assert.equal(map['sql querying'], 'sql');
  assert.equal(map['sql'], 'sql');
  assert.equal(map['roadmapping'], undefined, 'a name outside every group is not mapped');
});

test('a group naming a skill that was never in the input is ignored', async () => {
  const map = await mergeSkillNames(fake([{ name: 'python', variants: ['invented skill'] }]), ['python', 'sql']);
  assert.equal(map['invented skill'], undefined);
});

test('a failed model call leaves every name unmerged and says so', async () => {
  const result = await mergeSkillNames(async () => { throw new Error('cut off'); }, ['a', 'b']);
  assert.deepEqual(result, {});
});

test('a group whose name the model coined still merges the input names it lists', async () => {
  const map = await mergeSkillNames(fake([{ name: 'data visualization', variants: ['tableau dashboards', 'power bi reports', 'made up name'] }]), ['tableau dashboards', 'power bi reports', 'sql']);
  assert.equal(map['tableau dashboards'], 'data visualization');
  assert.equal(map['power bi reports'], 'data visualization');
  assert.equal(map['made up name'], undefined);
  assert.equal(map['sql'], undefined);
});

test('a group of more than six names is refused as over-merging and its names stay as they are', async () => {
  const many = Array.from({ length: 8 }, (_, i) => `skill ${i}`);
  const map = await mergeSkillNames(fake([{ name: 'everything', variants: many }, { name: 'sql', variants: ['writing sql'] }]), [...many, 'sql', 'writing sql']);
  assert.equal(map['skill 0'], undefined);
  assert.equal(map['writing sql'], 'sql');
});
