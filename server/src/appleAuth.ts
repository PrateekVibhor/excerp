// Sign in with Apple: checking the signed token the app sends (the same job as auth.ts does for Google), and revoking the reader's Apple access when their account is deleted.
// Nothing here stores anything. The key that signs our requests to Apple comes from the environment (see config.ts), never from the code.
import { createHash, createPublicKey, sign, verify, type JsonWebKeyInput } from 'node:crypto';
import { InvalidTokenError, MAX_TOKEN_CHARS, TokenServiceUnavailableError } from './auth.ts';

export const APPLE_ISSUER = 'https://appleid.apple.com';
const KEYS_URL = `${APPLE_ISSUER}/auth/keys`;

/** What a verified Apple token tells us. `email` is a real address or Apple's private-relay one (is_private_email); either is a verified address that reaches the reader. */
export interface AppleIdentity {
  /** Apple's stable id for this reader and this app. The account key. */
  sub: string;
  email: string;
  email_verified: boolean;
  is_private_email: boolean;
}
/** Checks the token against the raw nonce the app made for this sign-in. Throws InvalidTokenError or TokenServiceUnavailableError. */
export type AppleVerifier = (identityToken: string, nonce: string) => Promise<AppleIdentity>;
export type AppleKey = Extract<JsonWebKeyInput['key'], object> & { kid?: string };

const KEY_CACHE_MS = 60 * 60_000;
/** Apple's current public keys. `fresh` skips the one-hour memory (used once when a token names a key we do not have, since Apple rotates them). */
export function appleKeysFromApple(fetchFn: typeof fetch = fetch): (fresh: boolean) => Promise<AppleKey[]> {
  let kept: { at: number; keys: AppleKey[] } | undefined;
  return async (fresh) => {
    if (!fresh && kept && Date.now() - kept.at < KEY_CACHE_MS) return kept.keys;
    const res = await fetchFn(KEYS_URL, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error(`Apple's keys: ${res.status}`);
    const keys = ((await res.json()) as { keys?: AppleKey[] }).keys ?? [];
    kept = { at: Date.now(), keys };
    return keys;
  };
}

const isTrue = (v: unknown) => v === true || v === 'true';
const parse = (part: string): Record<string, unknown> | null => {
  try {
    const v = JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
    return typeof v === 'object' && v !== null && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
};

/**
 * The real check: RS256 signature against Apple's keys, issuer, audience (our bundle id), expiry, and that the token's nonce is the SHA-256 of the raw nonce the app sent
 * (the app gives Apple the hash and us the raw value, so a token taken from one sign-in cannot be replayed in another).
 */
export function createAppleVerifier({
  audience,
  getKeys = appleKeysFromApple(),
  now = () => new Date(),
}: {
  audience: string;
  getKeys?: (fresh: boolean) => Promise<AppleKey[]>;
  now?: () => Date;
}): AppleVerifier {
  return async (identityToken, nonce) => {
    const parts = typeof identityToken === 'string' && identityToken.length <= MAX_TOKEN_CHARS ? identityToken.split('.') : [];
    const header = parts.length === 3 ? parse(parts[0]) : null;
    const claims = parts.length === 3 ? parse(parts[1]) : null;
    if (!header || !claims || header.alg !== 'RS256' || typeof header.kid !== 'string' || typeof nonce !== 'string' || nonce === '') throw new InvalidTokenError('the token was not accepted');

    let key: AppleKey | undefined;
    try {
      key = (await getKeys(false)).find((k) => k.kid === header.kid) ?? (await getKeys(true)).find((k) => k.kid === header.kid);
    } catch {
      throw new TokenServiceUnavailableError("Apple's keys could not be fetched");
    }
    let signed = false;
    try {
      signed = key !== undefined && verify('RSA-SHA256', Buffer.from(`${parts[0]}.${parts[1]}`), createPublicKey({ key, format: 'jwk' }), Buffer.from(parts[2], 'base64url'));
    } catch {
      signed = false;
    }
    const aud = claims.aud;
    const sha = createHash('sha256').update(nonce).digest('hex');
    const ok =
      signed &&
      claims.iss === APPLE_ISSUER &&
      (aud === audience || (Array.isArray(aud) && aud.includes(audience))) &&
      typeof claims.exp === 'number' && claims.exp > now().getTime() / 1000 &&
      claims.nonce === sha &&
      typeof claims.sub === 'string' && claims.sub !== '' &&
      typeof claims.email === 'string' && claims.email !== '';
    if (!ok) throw new InvalidTokenError('the token was not accepted'); // never repeat which check failed or any part of the token
    return { sub: claims.sub as string, email: claims.email as string, email_verified: isTrue(claims.email_verified), is_private_email: isTrue(claims.is_private_email) };
  };
}

/**
 * Revokes the reader's Apple access for this app from the one-time code the app gets by asking them to sign in with Apple again. `expectedSub` is the Apple id of the account being
 * deleted: a code that belongs to anyone else revokes nothing. 'failed' for any reason; it never throws.
 */
export type AppleRevoker = (authorizationCode: string, expectedSub: string) => Promise<'revoked' | 'failed'>;

export function createAppleRevoker({
  teamId,
  keyId,
  privateKey,
  clientId,
  baseUrl = APPLE_ISSUER,
  fetchFn = fetch,
  now = () => new Date(),
}: {
  teamId: string;
  keyId: string;
  /** The contents of the .p8 key (PEM). */
  privateKey: string;
  /** The app's bundle id. */
  clientId: string;
  baseUrl?: string;
  fetchFn?: typeof fetch;
  now?: () => Date;
}): AppleRevoker {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const clientSecret = () => {
    const iat = Math.floor(now().getTime() / 1000);
    const data = `${b64({ alg: 'ES256', kid: keyId })}.${b64({ iss: teamId, iat, exp: iat + 300, aud: APPLE_ISSUER, sub: clientId })}`;
    return `${data}.${sign('sha256', Buffer.from(data), { key: privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url')}`;
  };
  const post = async (path: string, form: Record<string, string>) =>
    fetchFn(`${baseUrl}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(form), signal: AbortSignal.timeout(8000) });

  return async (code, expectedSub) => {
    try {
      const secret = clientSecret();
      const exchanged = await post('/auth/token', { client_id: clientId, client_secret: secret, code, grant_type: 'authorization_code' });
      if (!exchanged.ok) return 'failed';
      const tokens = (await exchanged.json()) as { refresh_token?: unknown; access_token?: unknown; id_token?: unknown };
      // Apple's own answer says who the code is for. Revoking someone else's access because the wrong Apple account signed in would be a different harm.
      const who = typeof tokens.id_token === 'string' ? parse(tokens.id_token.split('.')[1] ?? '') : null;
      if (!who || who.sub !== expectedSub) return 'failed';
      const [token, hint] = typeof tokens.refresh_token === 'string' ? [tokens.refresh_token, 'refresh_token'] : typeof tokens.access_token === 'string' ? [tokens.access_token, 'access_token'] : [];
      if (!token || !hint) return 'failed';
      const revoked = await post('/auth/revoke', { client_id: clientId, client_secret: secret, token, token_type_hint: hint });
      return revoked.ok ? 'revoked' : 'failed';
    } catch {
      return 'failed'; // the key, the network or Apple: the reason is not passed on, since it can name the key or the code
    }
  };
}
