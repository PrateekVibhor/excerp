import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(__dirname, '..', '..');
const eas = JSON.parse(readFileSync(join(root, 'eas.json'), 'utf8')) as { build: Record<string, { env?: Record<string, string>; developmentClient?: boolean; ios?: { simulator?: boolean }; extends?: string }> };
const appJson = JSON.parse(readFileSync(join(root, 'app.json'), 'utf8'));
const LIVE = /api\.excerp\.app|81\.85\.4\.151/;

describe('the end-to-end build profiles', () => {
  it('Scenario: Stand-in is build-time only - only e2e-api sets EXPO_PUBLIC_E2E', () => {
    for (const [name, profile] of Object.entries(eas.build)) {
      const has = profile.env !== undefined && 'EXPO_PUBLIC_E2E' in profile.env;
      expect(has).toBe(name === 'e2e-api');
    }
    expect(eas.build['e2e-api'].env!.EXPO_PUBLIC_E2E).toBe('true');
  });

  it('no profile inherits the flag by extending e2e-api', () => {
    for (const [name, profile] of Object.entries(eas.build)) {
      if (name !== 'e2e-api') expect(profile.extends).not.toBe('e2e-api');
    }
  });

  it('both test profiles build a simulator app that is not a development client', () => {
    for (const name of ['e2e-api', 'e2e-mock']) {
      expect(eas.build[name].developmentClient).not.toBe(true);
      expect(eas.build[name].ios?.simulator).toBe(true);
    }
  });

  it('e2e-api talks to the test server on this Mac, and e2e-mock to nothing', () => {
    expect(eas.build['e2e-api'].env).toMatchObject({ EXPO_PUBLIC_DATA_SOURCE: 'api', EXPO_PUBLIC_API_URL: 'http://localhost:8787' });
    expect(eas.build['e2e-mock'].env).toMatchObject({ EXPO_PUBLIC_DATA_SOURCE: 'mock' });
    expect(eas.build['e2e-mock'].env).not.toHaveProperty('EXPO_PUBLIC_API_URL');
  });

  it('Scenario: No live address - neither test profile mentions a live server, and neither carries a Google client id', () => {
    for (const name of ['e2e-api', 'e2e-mock']) {
      const env = JSON.stringify(eas.build[name]);
      expect(env).not.toMatch(LIVE);
      expect(env).not.toMatch(/GOOGLE/);
    }
  });

  it('plain HTTP to localhost is allowed, which only reaches the device itself', () => {
    expect(appJson.expo.ios.infoPlist.NSAppTransportSecurity.NSExceptionDomains.localhost).toEqual({ NSExceptionAllowsInsecureHTTPLoads: true });
  });
});
