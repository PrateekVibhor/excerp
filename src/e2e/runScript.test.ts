/** @jest-environment node */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = join(__dirname, '..', '..');
const runSh = join(root, 'e2e', 'run.sh');

/**
 * Runs e2e/run.sh with a PATH and HOME that hold no Maestro and no Java, so it must stop at the prerequisite check. /usr/bin is left
 * out because macOS's java launcher lives there and finds a user-level JDK whatever HOME says.
 */
function runWithoutTools() {
  const home = mkdtempSync(join(tmpdir(), 'e2e-home-'));
  return spawnSync('bash', [runSh], { env: { PATH: '/bin', HOME: home } as unknown as NodeJS.ProcessEnv, encoding: 'utf8', timeout: 30_000 });
}

describe('e2e/run.sh', () => {
  it('Scenario: Missing prerequisite - stops at once, names what is missing, and exits 2', () => {
    const res = runWithoutTools();
    expect(res.status).toBe(2);
    expect(res.stdout).toMatch(/Missing/);
    expect(res.stdout).toMatch(/Maestro/);
    expect(res.stdout).toMatch(/Java/);
  });

  it('does nothing else when a prerequisite is missing: no test server, no output folder, no install', () => {
    const res = runWithoutTools();
    expect(res.stdout).not.toMatch(/End-to-end run|test server up|installing|Results:/i); // the headings and lines a real run prints
  });

  it('is a bash script that stops on an undefined variable and cleans up the test server however it ends', () => {
    const text = readFileSync(runSh, 'utf8');
    expect(text.split('\n')[0]).toBe('#!/usr/bin/env bash');
    expect(text).toMatch(/^set -u/m);
    expect(text).toMatch(/trap cleanup EXIT/);
  });

  it('never points a flow at a live address', () => {
    expect(readFileSync(runSh, 'utf8')).not.toMatch(/api\.excerp\.app|81\.85\.4\.151/);
  });

  it('Scenario: Low disk - refuses to start when there is less free space than E2E_MIN_FREE_MB, before touching anything', () => {
    // A device and a flow that do not exist are set too, so even without the guard nothing could start.
    const res = spawnSync('bash', [runSh], { env: { ...process.env, E2E_MIN_FREE_MB: '999999999', E2E_DEVICE: 'none', E2E_ONLY: 'no-such-flow' } as unknown as NodeJS.ProcessEnv, encoding: 'utf8', timeout: 30_000 });
    expect(res.status).toBe(2);
    expect(res.stdout).toMatch(/free disk space/i);
    expect(res.stdout).not.toMatch(/End-to-end run|test server up|installing|Results:/i);
  });

  it('keeps its output small: a passing flow\'s debug folder is deleted, large logs are trimmed, and only the last runs are kept', () => {
    const text = readFileSync(runSh, 'utf8');
    expect(text).toMatch(/KEEP_RUNS/);
    expect(text).toMatch(/device-simulator\.log/);
    expect(text).toMatch(/rm -rf "\$\{OUT:\?\}\/\$group\/\$name"/); // a passing flow
  });
});

