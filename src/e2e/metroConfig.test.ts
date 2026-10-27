/** @jest-environment node */
// The stand-in for Google's sign-in must not be in the app at all unless the build is the end-to-end one (spec 12).

type Resolution = { type: string; filePath?: string };
type Config = { resolver: { resolveRequest: (context: unknown, moduleName: string, platform: string | null) => Resolution } };

function loadConfig(flag: string | undefined): Config {
  const before = process.env.EXPO_PUBLIC_E2E;
  if (flag === undefined) delete process.env.EXPO_PUBLIC_E2E;
  else process.env.EXPO_PUBLIC_E2E = flag;
  try {
    let config!: Config;
    jest.isolateModules(() => {
      config = require('../../metro.config.js');
    });
    return config;
  } finally {
    if (before === undefined) delete process.env.EXPO_PUBLIC_E2E;
    else process.env.EXPO_PUBLIC_E2E = before;
  }
}

// What Metro would do for any other module: a context whose own resolver answers.
const context = { resolveRequest: (_c: unknown, name: string) => ({ type: 'sourceFile', filePath: `/resolved/${name}` }) };
const resolve = (config: Config, name: string) => config.resolver.resolveRequest(context, name, 'ios');

describe('metro.config.js', () => {
  const stand = ['./fakeGoogle', '../src/features/auth/fakeGoogle', '../../src/features/auth/fakeGoogle'];

  it('outside the end-to-end build the stand-in resolves to nothing, so its code is not bundled', () => {
    for (const flag of [undefined, '', 'false', 'TRUE', '1', 'yes']) {
      const config = loadConfig(flag);
      for (const name of stand) expect(resolve(config, name)).toEqual({ type: 'empty' });
    }
  });

  it('in the end-to-end build (EXPO_PUBLIC_E2E exactly "true") the stand-in resolves like any other module', () => {
    const config = loadConfig('true');
    for (const name of stand) expect(resolve(config, name).type).not.toBe('empty');
  });

  it('every other module resolves as usual in both builds', () => {
    for (const flag of [undefined, 'true']) {
      const config = loadConfig(flag);
      for (const name of ['./googleSignIn', '../src/features/auth/AuthProvider', 'react', './fakeGoogleish', './notfakeGoogle']) {
        expect(resolve(config, name).type).not.toBe('empty');
      }
    }
  });
});
