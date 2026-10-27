import type { SendInput, SocialApi } from '../../data/socialApi';
import type { SendOutcome } from '../profile/InMailSheet';
import { explain } from './explain';

/** Sends a message request or a reply, and says how it went in words for the sheet. */
export async function sendMessage(social: SocialApi, input: SendInput): Promise<SendOutcome> {
  const res = await social.send(input);
  return res.kind === 'ok' ? { ok: true } : { ok: false, message: explain(res, "Couldn't send your message. Check your connection and try again.") };
}
