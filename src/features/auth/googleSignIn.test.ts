import { createGoogleSignInClient } from './googleSignIn';

const mockGoogle = { configure: jest.fn(), signIn: jest.fn(), signInSilently: jest.fn(), signOut: jest.fn() };
jest.mock('@react-native-google-signin/google-signin', () => ({ GoogleSignin: mockGoogle }));

const client = () => createGoogleSignInClient({ webClientId: 'web.apps.googleusercontent.com', iosClientId: 'ios.apps.googleusercontent.com' });
const success = (idToken: string | null) => ({ type: 'success', data: { idToken, user: { email: 'a@b.com' } } });

beforeEach(() => Object.values(mockGoogle).forEach((fn) => fn.mockReset()));

describe('googleSignIn', () => {
  it('is set up once, with the web client for the server and the iOS client', async () => {
    mockGoogle.signIn.mockResolvedValue(success('tok'));
    const c = client();
    await c.signIn();
    await c.signIn();
    expect(mockGoogle.configure).toHaveBeenCalledTimes(1);
    expect(mockGoogle.configure).toHaveBeenCalledWith({ webClientId: 'web.apps.googleusercontent.com', iosClientId: 'ios.apps.googleusercontent.com' });
  });

  it('a chosen account gives its ID token', async () => {
    mockGoogle.signIn.mockResolvedValue(success('the-id-token'));
    expect(await client().signIn()).toEqual({ kind: 'ok', idToken: 'the-id-token' });
  });

  it('a closed sheet is "cancelled", not an error', async () => {
    mockGoogle.signIn.mockResolvedValue({ type: 'cancelled', data: null });
    expect(await client().signIn()).toEqual({ kind: 'cancelled' });
  });

  it('a sign-in with no ID token is an error', async () => {
    mockGoogle.signIn.mockResolvedValue(success(null));
    expect(await client().signIn()).toEqual({ kind: 'error' });
  });

  it('a library failure is an error, and its message (which can carry details) is not passed on', async () => {
    mockGoogle.signIn.mockRejectedValue(Object.assign(new Error('DEVELOPER_ERROR secret detail'), { code: '10' }));
    const out = await client().signIn();
    expect(out).toEqual({ kind: 'error' });
    expect(JSON.stringify(out)).not.toMatch(/secret/);
  });

  it('a user cancelling that the library reports as a rejection is still "cancelled"', async () => {
    mockGoogle.signIn.mockRejectedValue(Object.assign(new Error('cancelled'), { code: 'SIGN_IN_CANCELLED' }));
    expect(await client().signIn()).toEqual({ kind: 'cancelled' });
  });

  it('a silent sign-in gives a fresh ID token without a sheet', async () => {
    mockGoogle.signInSilently.mockResolvedValue(success('fresh'));
    expect(await client().signInSilently()).toEqual({ kind: 'ok', idToken: 'fresh' });
  });

  it('a silent sign-in with no saved account is "none", and a failure is an error', async () => {
    mockGoogle.signInSilently.mockResolvedValue({ type: 'noSavedCredentialFound', data: null });
    expect(await client().signInSilently()).toEqual({ kind: 'none' });
    mockGoogle.signInSilently.mockRejectedValue(new Error('offline'));
    expect(await client().signInSilently()).toEqual({ kind: 'error' });
  });

  it('signing out never rejects', async () => {
    mockGoogle.signOut.mockResolvedValue(null);
    await expect(client().signOut()).resolves.toBeUndefined();
    mockGoogle.signOut.mockRejectedValue(new Error('x'));
    await expect(client().signOut()).resolves.toBeUndefined();
  });
});
