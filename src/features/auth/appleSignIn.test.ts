import { Platform } from 'react-native';
import { createAppleSignInClient } from './appleSignIn';

const mockApple = { isAvailableAsync: jest.fn(), signInAsync: jest.fn(), AppleAuthenticationScope: { FULL_NAME: 0, EMAIL: 1 } };
jest.mock('expo-apple-authentication', () => mockApple);
const mockCrypto = { getRandomBytes: jest.fn(), digestStringAsync: jest.fn(), CryptoDigestAlgorithm: { SHA256: 'SHA-256' } };
jest.mock('expo-crypto', () => mockCrypto);

const ok = { identityToken: 'identity.token.value', authorizationCode: 'auth-code', user: 'u', email: null, fullName: null };
const setOs = (os: string) => Object.defineProperty(Platform, 'OS', { value: os, configurable: true });

beforeEach(() => {
  setOs('ios');
  mockApple.isAvailableAsync.mockReset().mockResolvedValue(true);
  mockApple.signInAsync.mockReset().mockResolvedValue(ok);
  mockCrypto.getRandomBytes.mockReset().mockReturnValue(Uint8Array.from([1, 2, 255, 16]));
  mockCrypto.digestStringAsync.mockReset().mockImplementation(async (_alg: string, text: string) => `hash-of-${text}`);
});
afterAll(() => setOs('ios'));

describe('appleSignIn', () => {
  it('is available on iOS when the phone offers Sign in with Apple, and never on any other platform', async () => {
    expect(await createAppleSignInClient().isAvailable()).toBe(true);
    mockApple.isAvailableAsync.mockResolvedValue(false);
    expect(await createAppleSignInClient().isAvailable()).toBe(false);
    mockApple.isAvailableAsync.mockRejectedValue(new Error('no'));
    expect(await createAppleSignInClient().isAvailable()).toBe(false);
    setOs('android');
    mockApple.isAvailableAsync.mockResolvedValue(true);
    expect(await createAppleSignInClient().isAvailable()).toBe(false);
    expect(mockApple.isAvailableAsync).toHaveBeenCalledTimes(3); // not asked at all on Android
  });

  it('asks Apple for the email only (never the name) with the hash of a fresh random nonce, and gives back the token, the code and the raw nonce', async () => {
    const outcome = await createAppleSignInClient().signIn();
    expect(outcome).toEqual({ kind: 'ok', identityToken: 'identity.token.value', authorizationCode: 'auth-code', nonce: '0102ff10' });
    expect(mockApple.signInAsync).toHaveBeenCalledWith({ requestedScopes: [1], nonce: 'hash-of-0102ff10' });
  });

  it('every sign-in uses its own nonce', async () => {
    mockCrypto.getRandomBytes.mockReturnValueOnce(Uint8Array.from([1])).mockReturnValueOnce(Uint8Array.from([2]));
    const client = createAppleSignInClient();
    const [a, b] = [await client.signIn(), await client.signIn()];
    expect([a, b].map((o) => (o.kind === 'ok' ? o.nonce : null))).toEqual(['01', '02']);
  });

  it('closing the sheet is "cancelled", not an error', async () => {
    mockApple.signInAsync.mockRejectedValue(Object.assign(new Error('x'), { code: 'ERR_REQUEST_CANCELED' }));
    expect(await createAppleSignInClient().signIn()).toEqual({ kind: 'cancelled' });
  });

  it('any other failure, or an answer with no token or no code, is "error" and nothing from it is passed on', async () => {
    mockApple.signInAsync.mockRejectedValue(new Error('detail naming the account'));
    expect(await createAppleSignInClient().signIn()).toEqual({ kind: 'error' });
    for (const bad of [{ ...ok, identityToken: null }, { ...ok, identityToken: '' }, { ...ok, authorizationCode: null }]) {
      mockApple.signInAsync.mockResolvedValue(bad);
      expect(await createAppleSignInClient().signIn()).toEqual({ kind: 'error' });
    }
  });
});
