import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { CapReached, openLedger } from './creditLedger.ts';

const withDir = (run: (file: string) => void) => {
  const dir = mkdtempSync(join(tmpdir(), 'ledger-'));
  try {
    run(join(dir, 'ledger.json'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

test('charges are added up and reported', () =>
  withDir((file) => {
    const ledger = openLedger(file, { phase: 'R0', cap: 300 });
    ledger.charge(1, 'search a');
    ledger.charge(2, 'extract b');
    assert.equal(ledger.spent(), 3);
    assert.match(ledger.summary(), /R0: 3 of 300 credits/);
  }));

test('a charge that would pass the cap is refused and nothing is recorded', () =>
  withDir((file) => {
    const ledger = openLedger(file, { phase: 'R1', cap: 30 });
    ledger.charge(29, 'most of it');
    assert.throws(() => ledger.charge(2, 'one too many'), CapReached);
    assert.equal(ledger.spent(), 29);
    ledger.charge(1, 'exactly the cap is allowed');
    assert.equal(ledger.spent(), 30);
  }));

test('the reserve keeps the limit under the cap', () =>
  withDir((file) => {
    const ledger = openLedger(file, { phase: 'R0', cap: 300, reserve: 30 });
    ledger.charge(270, 'up to the limit');
    assert.throws(() => ledger.charge(1, 'into the reserve'), CapReached);
  }));

test('spending carries over to a new run of the same phase', () =>
  withDir((file) => {
    openLedger(file, { phase: 'R0', cap: 300 }).charge(100, 'first run');
    const second = openLedger(file, { phase: 'R0', cap: 300 });
    assert.equal(second.spent(), 100);
    assert.throws(() => second.charge(201, 'would pass the cap'), CapReached);
  }));

test('a phase never borrows from another phase', () =>
  withDir((file) => {
    openLedger(file, { phase: 'R0', cap: 300 }).charge(300, 'all of R0');
    const r1 = openLedger(file, { phase: 'R1', cap: 30 });
    assert.equal(r1.spent(), 0);
    assert.throws(() => r1.charge(31, 'more than R1 has'), CapReached);
    assert.equal(openLedger(file, { phase: 'R0', cap: 300 }).spent(), 300);
  }));

test('the file is marked partial once a cap has been hit', () =>
  withDir((file) => {
    const ledger = openLedger(file, { phase: 'R2', cap: 60 });
    ledger.charge(60, 'everything');
    assert.throws(() => ledger.charge(1, 'refused'), CapReached);
    const saved = JSON.parse(readFileSync(file, 'utf8'));
    assert.equal(saved.R2.partial, true);
    assert.equal(saved.R2.entries.length, 1);
  }));

test('a charge must be a positive whole number of credits', () =>
  withDir((file) => {
    const ledger = openLedger(file, { phase: 'R0', cap: 300 });
    for (const bad of [0, -1, 1.5, Number.NaN]) assert.throws(() => ledger.charge(bad, 'bad'), RangeError);
    assert.equal(ledger.spent(), 0);
  }));
