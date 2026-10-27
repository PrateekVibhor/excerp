// Sign in with Apple, the server's two halves, with keys made for the test: checking the signed token the app sends, and revoking the reader's Apple access when the account is deleted
// (against a small local server standing in for appleid.apple.com).
import assert from 'node:assert/strict';
import { createHash, createPublicKey, generateKeyPairSync, sign, verify } from 'node:crypto';
import { createServer, type IncomingMessage } from 'node:http';
import { test } from 'node:test';
import { InvalidTokenError, TokenServiceUnavailableError } from './auth.ts';
import { APPLE_ISSUER, createAppleRevoker, createAppleVerifier } from './appleAuth.ts';

const AUD = 'com.prateekvibhor.excerp';
const NOW = new Date('2026-10-23T12:00:00.000Z');
const nowSec = Math.floor(NOW.getTime() / 1000);
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const other = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'K1', alg: 'RS256', use: 'sig' };
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');

function token(claims: Record<string, unknown> = {}, opts: { key?: typeof privateKey; kid?: string; alg?: string } = {}) {
  const head = b64({ alg: opts.alg ?? 'RS256', kid: opts.kid ?? 'K1' });
  const body = b64({ iss: APPLE_ISSUER, aud: AUD, exp: nowSec + 600, iat: nowSec, sub: '001.abc', nonce: sha('raw-nonce'), email: 'ann@example.com', email_verified: 'true', ...claims });
  const sig = sign('RSA-SHA256', Buffer.from(`${head}.${body}`), opts.key ?? privateKey).toString('base64url');
  return `${head}.${body}.${sig}`;
}
const verifier = (extra: Partial<Parameters<typeof createAppleVerifier>[0]> = {}) => createAppleVerifier({ audience: AUD, getKeys: async () => [jwk], now: () => NOW, ...extra });

test('a good token gives the Apple id and the email', async () => {
  assert.deepEqual(await verifier()(token(), 'raw-nonce'), { sub: '001.abc', email: 'ann@example.com', email_verified: true, is_private_email: false });
});

test('a private-relay address is a verified address, and is marked as one (Apple sends the flags as strings or as booleans)', async () => {
  const id = await verifier()(token({ email: 'x7k2@privaterelay.appleid.com', is_private_email: 'true', email_verified: true }), 'raw-nonce');
  assert.deepEqual(id, { sub: '001.abc', email: 'x7k2@privaterelay.appleid.com', email_verified: true, is_private_email: true });
});

test('an expired token, the wrong audience, the wrong issuer, the wrong nonce, a wrong signature, another key id, a different algorithm and junk are all refused', async () => {
  const v = verifier();
  for (const [what, t, nonce] of [
    ['expired', token({ exp: nowSec - 1 }), 'raw-nonce'],
    ['audience', token({ aud: 'com.someone.else' }), 'raw-nonce'],
    ['issuer', token({ iss: 'https://accounts.google.com' }), 'raw-nonce'],
    ['nonce', token(), 'another-nonce'],
    ['no nonce in the token', token({ nonce: undefined }), 'raw-nonce'],
    ['signature', token({}, { key: other.privateKey }), 'raw-nonce'],
    ['key id', token({}, { kid: 'K9' }), 'raw-nonce'],
    ['algorithm', token({}, { alg: 'none' }), 'raw-nonce'],
    ['no subject', token({ sub: '' }), 'raw-nonce'],
    ['junk', 'not.a.token', 'raw-nonce'],
    ['empty', '', 'raw-nonce'],
    ['empty nonce', token(), ''],
    ['too long', 'a'.repeat(5000), 'raw-nonce'],
  ] as const) await assert.rejects(v(t, nonce), InvalidTokenError, what);
});

test('an audience given as a list that includes ours is accepted', async () => {
  assert.equal((await verifier()(token({ aud: ['x', AUD] }), 'raw-nonce')).sub, '001.abc');
});

test('a token with no email is refused (the app needs one to sign the reader in), and an unverified email is reported as unverified', async () => {
  await assert.rejects(verifier()(token({ email: undefined }), 'raw-nonce'), InvalidTokenError);
  assert.equal((await verifier()(token({ email_verified: 'false' }), 'raw-nonce')).email_verified, false);
});

test("when Apple's keys cannot be fetched the answer is 'unavailable', never 'invalid'; a key id not in the cached keys makes one fresh fetch", async () => {
  await assert.rejects(verifier({ getKeys: async () => { throw new Error('down'); } })(token(), 'raw-nonce'), TokenServiceUnavailableError);
  const calls: boolean[] = [];
  const v = verifier({ getKeys: async (fresh) => { calls.push(fresh); return fresh ? [jwk] : []; } });
  assert.equal((await v(token(), 'raw-nonce')).sub, '001.abc');
  assert.deepEqual(calls, [false, true]);
});

// --- revoking ---

interface Seen { path: string; form: URLSearchParams }
async function fakeApple(answer: (path: string, form: URLSearchParams) => { status: number; body?: unknown }) {
  const seen: Seen[] = [];
  const server = createServer(async (req: IncomingMessage, res) => {
    let text = '';
    for await (const chunk of req) text += chunk;
    const form = new URLSearchParams(text);
    seen.push({ path: req.url!, form });
    const a = answer(req.url!, form);
    res.writeHead(a.status, { 'Content-Type': 'application/json' }).end(JSON.stringify(a.body ?? {}));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  return { seen, baseUrl: `http://127.0.0.1:${port}`, close: () => new Promise<void>((r) => server.close(() => r())) };
}
const ec = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const pem = ec.privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
const idTokenFor = (sub: string) => `${b64({ alg: 'RS256' })}.${b64({ sub })}.sig`; // what Apple's token answer carries; we read who it is for, the answer comes straight from Apple
const SUB = 'apple-sub-1';
const revoker = (baseUrl: string, privateKeyText = pem) => createAppleRevoker({ teamId: 'TEAM123456', keyId: 'KEY1234567', privateKey: privateKeyText, clientId: AUD, baseUrl, now: () => NOW });

test('revoking exchanges the code for a token and then revokes it, with a client secret signed by our key', async () => {
  const apple = await fakeApple((path) => (path === '/auth/token' ? { status: 200, body: { refresh_token: 'R-1', access_token: 'A-1', id_token: idTokenFor(SUB) } } : { status: 200 }));
  try {
    assert.equal(await revoker(apple.baseUrl)('the-code', SUB), 'revoked');
    assert.deepEqual(apple.seen.map((s) => s.path), ['/auth/token', '/auth/revoke']);
    assert.equal(apple.seen[0].form.get('grant_type'), 'authorization_code');
    assert.equal(apple.seen[0].form.get('code'), 'the-code');
    assert.equal(apple.seen[0].form.get('client_id'), AUD);
    assert.equal(apple.seen[1].form.get('token'), 'R-1');
    assert.equal(apple.seen[1].form.get('token_type_hint'), 'refresh_token');
    const secret = apple.seen[1].form.get('client_secret')!;
    const [h, c, s] = secret.split('.');
    assert.deepEqual(JSON.parse(Buffer.from(h, 'base64url').toString()), { alg: 'ES256', kid: 'KEY1234567' });
    assert.deepEqual(JSON.parse(Buffer.from(c, 'base64url').toString()), { iss: 'TEAM123456', iat: nowSec, exp: nowSec + 300, aud: APPLE_ISSUER, sub: AUD });
    assert.ok(verify('sha256', Buffer.from(`${h}.${c}`), { key: createPublicKey(ec.privateKey), dsaEncoding: 'ieee-p1363' }, Buffer.from(s, 'base64url')), 'signed with our key');
  } finally {
    await apple.close();
  }
});

test('with only an access token, that is what is revoked', async () => {
  const apple = await fakeApple((path) => (path === '/auth/token' ? { status: 200, body: { access_token: 'A-1', id_token: idTokenFor(SUB) } } : { status: 200 }));
  try {
    assert.equal(await revoker(apple.baseUrl)('c', SUB), 'revoked');
    assert.equal(apple.seen[1].form.get('token'), 'A-1');
    assert.equal(apple.seen[1].form.get('token_type_hint'), 'access_token');
  } finally {
    await apple.close();
  }
});

test('a refusal from Apple, a missing token, an unreachable Apple and an unusable key are all just "failed": nothing thrown, nothing secret in the answer', async () => {
  for (const answer of [() => ({ status: 400, body: { error: 'invalid_grant' } }), (p: string) => (p === '/auth/token' ? { status: 200, body: {} } : { status: 200 }), (p: string) => (p === '/auth/token' ? { status: 200, body: { refresh_token: 'R', id_token: idTokenFor(SUB) } } : { status: 500 })]) {
    const apple = await fakeApple(answer);
    try {
      assert.equal(await revoker(apple.baseUrl)('c', SUB), 'failed');
    } finally {
      await apple.close();
    }
  }
  assert.equal(await revoker('http://127.0.0.1:1')('c', SUB), 'failed');
  assert.equal(await revoker('http://127.0.0.1:1', 'not a key')('c', SUB), 'failed');
});

test('a code that belongs to a different Apple account than the one being deleted revokes nothing, and neither does an answer that says nobody', async () => {
  for (const body of [{ refresh_token: 'R', id_token: idTokenFor('someone-else') }, { refresh_token: 'R' }, { refresh_token: 'R', id_token: 'junk' }]) {
    const apple = await fakeApple(() => ({ status: 200, body }));
    try {
      assert.equal(await revoker(apple.baseUrl)('c', SUB), 'failed');
      assert.deepEqual(apple.seen.map((s) => s.path), ['/auth/token'], 'it never got as far as revoking');
    } finally {
      await apple.close();
    }
  }
});
