// Source finder: the spending limits (per gap, per batch, and the ledger's own cap) are checked before a search is made, never after.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BatchLimit, GapLimit, createBudget } from './budget.ts';

const ledger = (cap = 100) => {
  let spent = 0;
  const calls: string[] = [];
  return { calls, charge(n: number, label: string) { if (spent + n > cap) throw new Error(`cap: ${label}`); spent += n; calls.push(label); }, spent: () => spent };
};

test('a gap may spend its own limit and no more; the next gap starts fresh', () => {
  const l = ledger();
  const b = createBudget({ perGap: 4, batch: 100, ledger: l });
  for (let i = 0; i < 4; i++) b.spend('a', `a${i}`);
  assert.throws(() => b.spend('a', 'a4'), GapLimit);
  assert.equal(l.spent(), 4, 'the refused search was not charged');
  b.spend('b', 'b0');
  assert.deepEqual([b.spentOn('a'), b.spentOn('b'), b.spentInBatch()], [4, 1, 5]);
});

test('the batch limit stops the whole run, before the search', () => {
  const l = ledger();
  const b = createBudget({ perGap: 4, batch: 3, ledger: l });
  b.spend('a', '1'); b.spend('a', '2'); b.spend('b', '3');
  assert.throws(() => b.spend('c', '4'), BatchLimit);
  assert.equal(l.spent(), 3);
});

test('the ledger\'s cap is respected too, and its refusal is passed on unchanged', () => {
  const l = ledger(2);
  const b = createBudget({ perGap: 4, batch: 10, ledger: l });
  b.spend('a', '1'); b.spend('a', '2');
  assert.throws(() => b.spend('a', '3'), /cap: 3/);
  assert.equal(b.spentOn('a'), 2, 'a refused charge is not counted as spent');
});
