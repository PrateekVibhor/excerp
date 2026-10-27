/** @jest-environment node */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// The production build is the one uploaded to Google Play: an app bundle (.aab), a version code that rises with every build, the live
// server over HTTPS, and Google sign-in switched on. None of the test or development settings may leak into it.
const root = join(__dirname, '..', '..');
const eas = JSON.parse(readFileSync(join(root, 'eas.json'), 'utf8')) as {
  cli: { appVersionSource?: string };
  build: Record<string, { autoIncrement?: boolean; developmentClient?: boolean; distribution?: string; extends?: string; android?: { buildType?: string }; env?: Record<string, string> }>;
};
const production = eas.build.production;

describe('the production build profile', () => {
  it('exists', () => expect(production).toBeDefined());

  it('makes an app bundle for Google Play, not an APK', () => {
    expect(production.android?.buildType).toBe('app-bundle');
  });

  it('raises the version code on every build, which Google Play requires, and EAS keeps it', () => {
    expect(production.autoIncrement).toBe(true);
    expect(eas.cli.appVersionSource).toBe('remote');
  });

  it('is a store build: not a development client, and it extends no development or test profile', () => {
    expect(production.developmentClient).not.toBe(true);
    expect(production.extends ?? '').not.toMatch(/development|e2e/);
  });

  it('talks to the live server over HTTPS, never to a bare address or plain HTTP', () => {
    const env = production.env!;
    expect(env.EXPO_PUBLIC_DATA_SOURCE).toBe('api');
    expect(env.EXPO_PUBLIC_API_URL).toBe('https://YOUR-API-HOST');
    expect(JSON.stringify(env)).not.toMatch(/http:\/\/|81\.85\.4\.151|localhost|127\.0\.0\.1/);
  });

  it('switches Google sign-in on: the web client id is set (and the iOS one, for a later iOS build)', () => {
    const env = production.env!;
    expect(env.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID).toMatch(/^\d+-[a-z0-9]+\.apps\.googleusercontent\.com$/);
    expect(env.EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID).toMatch(/^\d+-[a-z0-9]+\.apps\.googleusercontent\.com$/);
  });

  it('does not carry the end-to-end test flag or any other test setting', () => {
    expect(Object.keys(production.env!).filter((k) => /E2E|TEST/i.test(k))).toEqual([]);
  });

  it('uses the same Google clients as the development builds, so sign-in behaves the same', () => {
    const dev = eas.build.development.env!;
    expect(production.env!.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID).toBe(dev.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID);
    expect(production.env!.EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID).toBe(dev.EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID);
  });
});
