import * as fs from 'fs';
import * as path from 'path';

const config = JSON.parse(fs.readFileSync(path.join(__dirname, '../app.json'), 'utf8')).expo;

describe('app.json and Sign in with Apple', () => {
  it('turns on the Sign in with Apple capability for the iPhone app (the entitlement is added when the app is built)', () => {
    expect(config.ios.usesAppleSignIn).toBe(true);
    expect(config.plugins).toContain('expo-apple-authentication');
  });

  it('leaves the bundle id alone: the server checks Apple tokens against it', () => {
    expect(config.ios.bundleIdentifier).toBe('com.prateekvibhor.excerp');
  });

  it('adds nothing to Android, which Apple\'s rule does not cover', () => {
    expect(JSON.stringify(config.android)).not.toMatch(/apple/i);
  });

  it('keeps the bundle id and Sign in with Apple together with the transport-security settings below', () => {
    expect(config.ios.usesAppleSignIn).toBe(true);
    expect(config.ios.bundleIdentifier).toBe('com.prateekvibhor.excerp');
  });
});

describe('app.json iOS plain-HTTP settings', () => {
  const ats = config.ios.infoPlist.NSAppTransportSecurity;
  const domains = ats.NSExceptionDomains as Record<string, Record<string, unknown>>;

  it('allows plain HTTP to localhost only, for development, and to no other address (the old server address is gone)', () => {
    expect(Object.keys(domains)).toEqual(['localhost']);
    expect(domains.localhost.NSExceptionAllowsInsecureHTTPLoads).toBe(true);
    expect(JSON.stringify(config.ios)).not.toContain('YOUR-API-HOST');
  });

  it('does not switch App Transport Security off for everything', () => {
    expect(ats.NSAllowsArbitraryLoads).toBeUndefined();
    expect(ats.NSAllowsLocalNetworking).toBeUndefined();
  });

  it('leaves the Android plugin host as it is (that is a separate decision)', () => {
    expect(JSON.stringify(config.plugins)).toContain('"host":"YOUR-API-HOST"');
  });
});
