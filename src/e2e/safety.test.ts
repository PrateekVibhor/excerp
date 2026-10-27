/** @jest-environment node */
// The safety promises of the end-to-end tests (spec 12), kept as tests so they cannot quietly stop being true.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const root = join(__dirname, '..', '..');
const SKIP_DIRS = new Set(['node_modules', 'output', 'builds', '.git']);

function filesUnder(dir: string, keep: (path: string) => boolean = () => true): string[] {
  return readdirSync(dir).flatMap((name) => {
    if (SKIP_DIRS.has(name)) return [];
    const path = join(dir, name);
    return statSync(path).isDirectory() ? filesUnder(path, keep) : keep(path) ? [path] : [];
  });
}
const text = (path: string) => readFileSync(path, 'utf8');
const rel = (path: string) => relative(root, path);
const isText = (p: string) => /\.(ya?ml|js|ts|tsx|sh|md|json)$/.test(p);

const e2eFiles = filesUnder(join(root, 'e2e'), isText);
const e2eServerFiles = filesUnder(join(root, 'server', 'e2e'), isText);
const flowFiles = filesUnder(join(root, 'e2e', 'flows'), (p) => p.endsWith('.yaml'));
const scriptFiles = filesUnder(join(root, 'e2e', 'scripts'), (p) => p.endsWith('.js'));

describe('Scenario: No live address - nothing in the end-to-end material points at a live server', () => {
  const LIVE = /api\.excerp\.app|81\.85\.4\.151|excerp\.app/;

  it('no file in e2e/ or server/e2e/ names a live address', () => {
    for (const file of [...e2eFiles, ...e2eServerFiles]) expect([rel(file), LIVE.test(text(file))]).toEqual([rel(file), false]);
  });

  it('every web address in those files is this machine, or the Maestro site named in a message', () => {
    // "${host}" is the test server printing where it listens (always 127.0.0.1); it makes no request.
    const allowed = new Set(['localhost', '127.0.0.1', 'maestro.mobile.dev', '${host}']);
    for (const file of [...e2eFiles, ...e2eServerFiles]) {
      for (const m of text(file).matchAll(/https?:\/\/([^/\s"'`)<>:;,]+)/g)) expect([rel(file), m[1], allowed.has(m[1])]).toEqual([rel(file), m[1], true]);
    }
  });

  it('the two test build profiles do not name a live server either', () => {
    const eas = JSON.parse(text(join(root, 'eas.json'))).build;
    for (const name of ['e2e-api', 'e2e-mock']) expect(JSON.stringify(eas[name])).not.toMatch(LIVE);
  });
});

describe('Scenario: Test server cannot reach production - the live image holds none of it', () => {
  const dockerfile = text(join(root, 'server', 'Dockerfile'));
  const ignore = text(join(root, 'server', 'Dockerfile.dockerignore'));
  const serverSrc = filesUnder(join(root, 'server', 'src'), (p) => p.endsWith('.ts') && !p.endsWith('.test.ts'));

  it('the image copies only the package files, the shared types and server/src', () => {
    const sources = [...dockerfile.matchAll(/^COPY\s+(\S+)\s+\S+/gm)].map((m) => m[1]);
    expect(sources.sort()).toEqual(['server/package.json server/package-lock.json'.split(' ')[0], 'server/src', 'src/data/types.ts'].sort());
    expect(dockerfile).toMatch(/^COPY server\/package\.json server\/package-lock\.json /m);
    expect(dockerfile).not.toMatch(/^COPY\s+(\.|server\/?|\*)\s/m); // never the whole folder
    expect(dockerfile).not.toMatch(/e2e/);
  });

  it('the build context sends nothing else: it ignores everything and lets through only what the image needs', () => {
    const lines = ignore.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
    expect(lines[0]).toBe('*');
    expect(lines.filter((l) => l.startsWith('!')).sort()).toEqual(['!server/package-lock.json', '!server/package.json', '!server/src', '!src/data/types.ts']);
    expect(ignore).not.toMatch(/e2e/);
  });

  it('the production code never imports the test server or knows the test token', () => {
    for (const file of serverSrc) {
      const code = text(file);
      expect([rel(file), /from\s+['"][^'"]*\/e2e\//.test(code)]).toEqual([rel(file), false]);
      expect([rel(file), /['"`]e2e:/.test(code)]).toEqual([rel(file), false]); // "e2e:<email>" is accepted only in server/e2e
    }
  });

  it('the compose file does not mount or run anything from e2e', () => {
    expect(text(join(root, 'server', 'docker-compose.yml'))).not.toMatch(/e2e/);
  });

  it('the app never imports the stand-in for Google except where it is switched on', () => {
    const appFiles = [...filesUnder(join(root, 'src'), (p) => /\.tsx?$/.test(p) && !/\.test\./.test(p)), ...filesUnder(join(root, 'app'), (p) => /\.tsx?$/.test(p))];
    const users = appFiles.filter((f) => /fakeGoogle/.test(text(f)) && !f.endsWith('fakeGoogle.tsx')).map(rel).sort();
    expect(users).toEqual(['app/_layout.tsx', 'src/features/auth/authConfig.ts']);
    for (const f of users) expect([f, /require\(['"][^'"]*fakeGoogle['"]\)/.test(text(join(root, f)))]).toEqual([f, true]); // required inside a flag check, never a static import
    for (const f of users) expect([f, /^import .*fakeGoogle/m.test(text(join(root, f)))]).toEqual([f, false]);
  });
});

describe('Scenario: No fixed sleeps - every wait names the text it waits for', () => {
  // The commands a flow may use. None of them waits for a fixed time.
  const allowed = new Set(['appId', 'launchApp', 'runFlow', 'runScript', 'extendedWaitUntil', 'tapOn', 'swipe', 'scrollUntilVisible', 'assertVisible', 'assertNotVisible', 'assertTrue', 'takeScreenshot', 'openLink']);
  const commandsOf = (yaml: string) => [...yaml.matchAll(/^- (\w+)/gm)].map((m) => m[1]);

  it('flows use only commands from the list above, so there is no sleep, delay or animation wait', () => {
    for (const file of flowFiles) for (const command of commandsOf(text(file))) expect([rel(file), allowed.has(command)]).toEqual([rel(file), true]);
  });

  it('every extendedWaitUntil waits for named text to appear or go, with a limit', () => {
    for (const file of flowFiles) {
      for (const block of text(file).split(/^- (?=extendedWaitUntil)/m).slice(1)) {
        const body = block.split(/^- /m)[0];
        expect([rel(file), /^\s+(visible|notVisible):\s*"[^"]+"/m.test(body)]).toEqual([rel(file), true]);
        expect([rel(file), /^\s+timeout:\s*\d+/m.test(body)]).toEqual([rel(file), true]);
      }
    }
  });

  it('no flow or script sleeps: no wait-for-time command, timer, or busy loop', () => {
    for (const file of [...flowFiles, ...scriptFiles]) {
      expect([rel(file), /waitForAnimationToEnd|\bsleep\b|setTimeout|setInterval|Atomics\.wait|while\s*\(true\)|for\s*\(;;\)/.test(text(file))]).toEqual([rel(file), false]);
    }
  });

  it('run.sh sleeps only inside a polling loop that can leave early: it waits for the server to answer or stop, never for a fixed time', () => {
    const run = text(join(root, 'e2e', 'run.sh'));
    const loops = [...run.matchAll(/(?:^|\n)\s*for [^\n]*?; do([\s\S]*?)\bdone\b/g)].map((m) => m[1]);
    const inLoops = loops.filter((body) => /\bsleep\b/.test(body));
    expect(inLoops.length).toBeGreaterThan(0);
    for (const body of inLoops) {
      expect(body).toMatch(/break/); // it can stop as soon as the thing it waits for has happened
      expect(body).toMatch(/kill -0|\/e2e\/ready/); // and that thing is the test server answering or exiting
    }
    const sleeps = (run.match(/\bsleep\b/g) ?? []).length;
    const sleepsInLoops = inLoops.reduce((n, body) => n + (body.match(/\bsleep\b/g) ?? []).length, 0);
    expect(sleeps).toBe(sleepsInLoops); // none outside a loop
  });
});
