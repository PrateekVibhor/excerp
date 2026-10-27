import { OAuth2Client } from 'google-auth-library';

/** What a verified Google ID token tells us about the reader. */
export interface GoogleIdentity {
  email: string;
  email_verified: boolean;
  /** Google's stable, never-reused id for the account. The account key; the email can change. */
  sub: string;
}

/** The token is not one Google issued for this app, or it has expired. The answer is 401. */
export class InvalidTokenError extends Error {}
/** Google's keys could not be fetched, so no token can be judged right now. The answer is 503. */
export class TokenServiceUnavailableError extends Error {}

/** Checks a Google ID token and returns who it is for. Throws InvalidTokenError or TokenServiceUnavailableError. */
export type TokenVerifier = (idToken: string) => Promise<GoogleIdentity>;

const ISSUERS = ['accounts.google.com', 'https://accounts.google.com'];
/** An ID token is a few hundred to about two thousand characters; anything longer is not one. */
export const MAX_TOKEN_CHARS = 4096;

/**
 * The real check: signature against Google's keys, expiry, issuer, and that the token was made for this app
 * (`clientId`, the web client). `getCerts` returns Google's current public keys by key id; the default asks Google
 * (the library caches them), and tests give their own.
 */
export function createGoogleVerifier({
  clientId,
  getCerts = async () => (await new OAuth2Client().getFederatedSignonCertsAsync()).certs as Record<string, string>,
}: {
  clientId: string;
  getCerts?: () => Promise<Record<string, string>>;
}): TokenVerifier {
  const client = new OAuth2Client(clientId);
  return async (idToken) => {
    let certs: Record<string, string>;
    try {
      certs = await getCerts();
    } catch {
      throw new TokenServiceUnavailableError('Google\'s keys could not be fetched');
    }
    let payload;
    try {
      if (typeof idToken !== 'string' || idToken.length === 0 || idToken.length > MAX_TOKEN_CHARS) throw new Error('not a token');
      const login = await client.verifySignedJwtWithCertsAsync(idToken, certs, clientId, ISSUERS);
      payload = login.getPayload();
    } catch {
      throw new InvalidTokenError('the token was not accepted'); // never repeat the library's detail: it can echo the token
    }
    if (!payload || typeof payload.email !== 'string') throw new InvalidTokenError('the token has no email');
    if (typeof payload.sub !== 'string' || payload.sub === '') throw new InvalidTokenError('the token has no subject');
    return { email: payload.email, email_verified: payload.email_verified === true, sub: payload.sub };
  };
}

const EMAIL = /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/;
/** Trimmed and lower-cased, nothing else (dots and "+tags" are kept). Null when the text is not an email address. */
export function normalizeEmail(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const email = raw.trim().toLowerCase();
  return email.length <= 254 && EMAIL.test(email) ? email : null;
}
