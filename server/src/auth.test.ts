import assert from 'node:assert/strict';
import { createSign, generateKeyPairSync, type KeyObject } from 'node:crypto';
import { test } from 'node:test';
import { createGoogleVerifier, InvalidTokenError, normalizeEmail, TokenServiceUnavailableError } from './auth.ts';

const CLIENT_ID = 'web-client-id.apps.googleusercontent.com';
const NOW_S = Math.floor(Date.now() / 1000);

// Real RS256 signatures made with a key generated here, so the verifier's checks are the real ones. Google's own keys are
// stood in for by `certs`.
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const other = generateKeyPairSync('rsa', { modulusLength: 2048 });
const pem = (key: KeyObject) => key.export({ type: 'spki', format: 'pem' }).toString();
const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');

function token(claims: Record<string, unknown> = {}, { key = privateKey, kid = 'k1' }: { key?: KeyObject; kid?: string } = {}) {
  const header = b64({ alg: 'RS256', typ: 'JWT', kid });
  const payload = b64({ iss: 'https://accounts.google.com', aud: CLIENT_ID, sub: '1', email: 'tester@example.com', email_verified: true, iat: NOW_S, exp: NOW_S + 3600, ...claims });
  const signature = createSign('RSA-SHA256').update(`${header}.${payload}`).sign(key).toString('base64url');
  return `${header}.${payload}.${signature}`;
}
const verifier = (getCerts = async () => ({ k1: pem(publicKey) })) => createGoogleVerifier({ clientId: CLIENT_ID, getCerts });
const rejects = (promise: Promise<unknown>, type: new (...args: never[]) => Error) => assert.rejects(promise, (error) => error instanceof type);

test('a good token gives the email and whether Google says it is verified', async () => {
  assert.deepEqual(await verifier()(token()), { email: 'tester@example.com', email_verified: true, sub: '1' });
  assert.deepEqual(await verifier()(token({ email_verified: false })), { email: 'tester@example.com', email_verified: false, sub: '1' });
});

test('the email comes back as Google sent it; matching is done elsewhere', async () => {
  assert.equal((await verifier()(token({ email: 'Tester@Example.com' }))).email, 'Tester@Example.com');
});

test('both forms of Google\'s issuer are accepted', async () => {
  await verifier()(token({ iss: 'accounts.google.com' }));
  await verifier()(token({ iss: 'https://accounts.google.com' }));
});

test('a token with another issuer is refused', async () => {
  await rejects(verifier()(token({ iss: 'https://evil.example.com' })), InvalidTokenError);
});

test('a token made for another app (another audience) is refused', async () => {
  await rejects(verifier()(token({ aud: 'someone-elses-client.apps.googleusercontent.com' })), InvalidTokenError);
});

test('an expired token is refused', async () => {
  await rejects(verifier()(token({ iat: NOW_S - 7200, exp: NOW_S - 3600 })), InvalidTokenError);
});

test('a token signed with a key that is not Google\'s is refused', async () => {
  await rejects(verifier()(token({}, { key: other.privateKey })), InvalidTokenError);
});

test('a token whose content was changed after signing is refused', async () => {
  const [header, , signature] = token().split('.');
  const forged = `${header}.${b64({ iss: 'https://accounts.google.com', aud: CLIENT_ID, sub: '1', email: 'boss@example.com', email_verified: true, iat: NOW_S, exp: NOW_S + 3600 })}.${signature}`;
  await rejects(verifier()(forged), InvalidTokenError);
});

test('a token with no key id Google knows is refused', async () => {
  await rejects(verifier()(token({}, { kid: 'unknown' })), InvalidTokenError);
});

test('text that is not a token is refused', async () => {
  for (const junk of ['', 'abc', 'a.b.c', '{}', 'x'.repeat(5000)]) await rejects(verifier()(junk), InvalidTokenError);
});

test('a token with no email is refused', async () => {
  await rejects(verifier()(token({ email: undefined })), InvalidTokenError);
  await rejects(verifier()(token({ email: 42 })), InvalidTokenError);
});

test('a token with no subject is refused: the account key is the sub', async () => {
  await rejects(verifier()(token({ sub: undefined })), InvalidTokenError);
  await rejects(verifier()(token({ sub: '' })), InvalidTokenError);
});

test('when Google\'s keys cannot be fetched, that is "unavailable", not "invalid token"', async () => {
  const down = verifier(async () => {
    throw new Error('getaddrinfo ENOTFOUND www.googleapis.com');
  });
  await rejects(down(token()), TokenServiceUnavailableError);
});

test('a token is judged only after the keys are fetched, so a bad token is not reported as an outage', async () => {
  await rejects(verifier()(token({ aud: 'x' })), InvalidTokenError);
});

test('normalizeEmail trims and lower-cases, and changes nothing else', () => {
  assert.equal(normalizeEmail('  Tester@Example.COM '), 'tester@example.com');
  assert.equal(normalizeEmail('first.last+tag@sub.example.com'), 'first.last+tag@sub.example.com');
  assert.equal(normalizeEmail('t.e.s.t@gmail.com'), 't.e.s.t@gmail.com'); // dots are not removed
});

test('normalizeEmail returns null for anything that is not an address', () => {
  for (const bad of ['', '   ', 'plain', 'a@', '@b.com', 'a b@c.com', 'a@b', 'a@@b.com', `${'a'.repeat(250)}@b.com`, null, undefined, 42, {}]) {
    assert.equal(normalizeEmail(bad), null, String(bad));
  }
});
