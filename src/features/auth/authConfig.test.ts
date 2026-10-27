import { createAuthDeps } from './authConfig';

describe('createAuthDeps', () => {
  const full = { source: 'api', apiUrl: 'https://api.example.test', webClientId: 'web.apps.googleusercontent.com', iosClientId: 'ios.apps.googleusercontent.com' };

  it('Scenario: Mock data - there is no gate', () => {
    expect(createAuthDeps({ ...full, source: 'mock' })).toBeNull();
    expect(createAuthDeps({ ...full, source: undefined })).toBeNull();
  });

  it('a build with no server address or no Google web client id has no gate, so builds that predate sign-in are unaffected', () => {
    expect(createAuthDeps({ ...full, apiUrl: undefined })).toBeNull();
    expect(createAuthDeps({ ...full, apiUrl: '' })).toBeNull();
    expect(createAuthDeps({ ...full, webClientId: undefined })).toBeNull();
    expect(createAuthDeps({ ...full, webClientId: '' })).toBeNull();
  });

  it('with the live data source, a server address and a web client id the gate has what it needs', () => {
    const deps = createAuthDeps(full);
    expect(deps).not.toBeNull();
    expect(Object.keys(deps!).sort()).toEqual(['api', 'google', 'sessions']);
  });

  it('on an iPhone build the gate also has the Apple client; on any other platform, or in the end-to-end build, it does not', () => {
    expect(Object.keys(createAuthDeps({ ...full, ios: true })!).sort()).toEqual(['api', 'apple', 'google', 'sessions']);
    expect(Object.keys(createAuthDeps({ ...full, ios: false })!).sort()).toEqual(['api', 'google', 'sessions']);
    expect(Object.keys(createAuthDeps({ source: 'api', apiUrl: 'http://localhost:8787', e2e: 'true', ios: true })!).sort()).toEqual(['api', 'google', 'sessions']);
  });

  it('the iOS client id is optional (Android has none)', () => {
    expect(createAuthDeps({ ...full, iosClientId: undefined })).not.toBeNull();
  });

  describe('the end-to-end test build', () => {
    const e2e = { source: 'api', apiUrl: 'http://localhost:8787', e2e: 'true' };

    it('uses the stand-in for Google, and needs no web client id', () => {
      const deps = createAuthDeps(e2e);
      expect(deps).not.toBeNull();
      // The stand-in answers without the native library; the real client would try to load it.
      expect(typeof deps!.google.signIn).toBe('function');
      return expect(deps!.google.signInSilently()).resolves.toEqual({ kind: 'none' });
    });

    it('is the stand-in only when the flag is exactly "true"', async () => {
      for (const flag of [undefined, '', 'false', 'TRUE', '1', 'yes']) {
        const deps = createAuthDeps({ ...full, e2e: flag });
        expect(deps).not.toBeNull();
        // the real client: no stand-in, so the real library would be asked (which does not exist in a unit test)
        await expect(deps!.google.signInSilently()).resolves.toEqual({ kind: 'error' });
      }
    });

    it('with the flag but on mock data there is still no gate', () => {
      expect(createAuthDeps({ source: 'mock', e2e: 'true' })).toBeNull();
    });

    it('with the flag but no server address there is no gate', () => {
      expect(createAuthDeps({ source: 'api', e2e: 'true' })).toBeNull();
    });
  });
});
