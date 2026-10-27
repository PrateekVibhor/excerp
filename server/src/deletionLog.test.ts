import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createFileDeletionLog, DELETION_LOG_DAYS } from './deletionLog.ts';

const NOW = new Date('2026-10-10T12:00:00.000Z');
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000);

async function withFile(fn: (path: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), 'dellog-'));
  try {
    await fn(join(dir, 'deleted-accounts.log'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('records one line per deletion: the time and the hash, in the order they happened', () =>
  withFile(async (path) => {
    const log = createFileDeletionLog(path);
    await log.record('a'.repeat(64), daysAgo(2));
    await log.record('b'.repeat(64), daysAgo(1));
    assert.equal(await readFile(path, 'utf8'), `${daysAgo(2).toISOString()} ${'a'.repeat(64)}\n${daysAgo(1).toISOString()} ${'b'.repeat(64)}\n`);
  }));

test('prune drops lines older than the retention period and keeps the rest, and a line it cannot read', () =>
  withFile(async (path) => {
    const log = createFileDeletionLog(path);
    await writeFile(path, `${daysAgo(DELETION_LOG_DAYS + 1).toISOString()} old\n${daysAgo(DELETION_LOG_DAYS - 1).toISOString()} recent\nnot-a-date garbage\n`);
    assert.equal(await log.prune(NOW), 1);
    assert.equal(await readFile(path, 'utf8'), `${daysAgo(DELETION_LOG_DAYS - 1).toISOString()} recent\nnot-a-date garbage\n`);
    assert.equal(await log.prune(NOW), 0); // nothing more to drop
  }));

test('prune on a file that does not exist yet is nothing to do', () =>
  withFile(async (path) => {
    assert.equal(await createFileDeletionLog(path).prune(NOW), 0);
  }));
