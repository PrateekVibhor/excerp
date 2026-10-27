/** The server's routes for readers who choose to be seen, blocks, reports and message requests (Plan 15). */

export type ReportReason = 'spam' | 'harassment' | 'hate' | 'sexual' | 'scam' | 'other';
export const REPORT_REASONS: ReadonlyArray<{ id: ReportReason; label: string }> = [
  { id: 'spam', label: 'Spam or unwanted promotion' },
  { id: 'harassment', label: 'Harassment or threats' },
  { id: 'hate', label: 'Hateful or abusive' },
  { id: 'sexual', label: 'Sexual content' },
  { id: 'scam', label: 'Scam or deception' },
  { id: 'other', label: 'Something else' },
];

export interface MessagingSettings {
  discoverable: boolean;
  accepts_messages: boolean;
  adult_confirmed: boolean;
  terms_accepted: boolean;
}
export interface SettingsPatch {
  discoverable?: boolean;
  accepts_messages?: boolean;
  confirm_adult?: true;
  accept_terms?: true;
}
export interface ReaderEntry {
  public_id: string;
  display_name: string;
  industry: string;
  interests: string[];
  shared_interests: number;
  action: 'saved' | 'verified';
  can_message: boolean;
}
export interface ReadersAnswer {
  count: number;
  readers: ReaderEntry[];
}
export interface ReaderCard {
  public_id: string;
  display_name: string;
  industry: string;
  interests: string[];
  verified_count: number;
  can_message: boolean;
}
export interface BlockEntry {
  public_id: string;
  display_name: string;
  blocked_at: string;
}
export interface OtherView {
  public_id: string | null;
  display_name: string;
  industry: string | null;
  interests: string[];
  deleted: boolean;
}
export interface MessageView {
  id: string;
  from: 'me' | 'them';
  subject: string;
  body: string;
  created_at: string;
  read: boolean;
}
export interface ConversationView {
  id: string;
  state: 'request' | 'open' | 'pending' | 'expired' | 'declined' | 'gone';
  role: 'initiator' | 'recipient';
  other: OtherView;
  article_id: string | null;
  created_at: string;
  last_message_at: string;
  unread: number;
  last_message: MessageView | null;
}
export interface Inbox {
  cursor: number;
  unread: number;
  requests: ConversationView[];
  conversations: ConversationView[];
  sent: ConversationView[];
}
export type Thread = ConversationView & { messages: MessageView[] };

export interface SendInput {
  /** A new request to the reader with this public id, or ... */
  to?: string;
  /** ... a reply in this conversation. */
  conversationId?: string;
  subject: string;
  body: string;
  articleId?: string;
}
export interface ReportInput {
  publicId?: string;
  messageId?: string;
  reason: ReportReason;
  note?: string;
  articleId?: string;
  alsoBlock?: boolean;
}

/**
 * What came back. 'refused' carries the server's own status and a short code (for instance 403 `visibility_required`, 409
 * `already_requested`, 400 `no links`); 'unauthorized' (401) means the session is gone; 'failed' is anything else: offline, busy, nonsense.
 */
export type SocialResult<T> = { kind: 'ok'; value: T } | { kind: 'refused'; status: number; code: string } | { kind: 'unauthorized' } | { kind: 'failed' };

export interface SocialApi {
  getSettings(): Promise<SocialResult<MessagingSettings>>;
  putSettings(patch: SettingsPatch): Promise<SocialResult<MessagingSettings>>;
  readers(articleId: string): Promise<SocialResult<ReadersAnswer>>;
  card(publicId: string): Promise<SocialResult<ReaderCard>>;
  blocks(): Promise<SocialResult<BlockEntry[]>>;
  block(publicId: string): Promise<SocialResult<null>>;
  unblock(publicId: string): Promise<SocialResult<null>>;
  report(input: ReportInput): Promise<SocialResult<null>>;
  send(input: SendInput): Promise<SocialResult<null>>;
  inbox(): Promise<SocialResult<Inbox>>;
  thread(conversationId: string): Promise<SocialResult<Thread>>;
  accept(conversationId: string): Promise<SocialResult<null>>;
  decline(conversationId: string): Promise<SocialResult<null>>;
  markRead(messageId: string): Promise<SocialResult<null>>;
  hide(messageId: string): Promise<SocialResult<null>>;
}

type Fetch = typeof fetch;
const TIMEOUT_MS = 15_000;
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): v is string => typeof v === 'string';
const strs = (v: unknown): v is string[] => Array.isArray(v) && v.every(str);
const bool = (v: unknown): v is boolean => typeof v === 'boolean';
const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

function readSettings(v: unknown): MessagingSettings | null {
  return isObject(v) && bool(v.discoverable) && bool(v.accepts_messages) && bool(v.adult_confirmed) && bool(v.terms_accepted)
    ? { discoverable: v.discoverable, accepts_messages: v.accepts_messages, adult_confirmed: v.adult_confirmed, terms_accepted: v.terms_accepted }
    : null;
}
function readReader(v: unknown): ReaderEntry | null {
  return isObject(v) && str(v.public_id) && str(v.display_name) && str(v.industry) && strs(v.interests) && num(v.shared_interests) && (v.action === 'saved' || v.action === 'verified') && bool(v.can_message)
    ? { public_id: v.public_id, display_name: v.display_name, industry: v.industry, interests: v.interests, shared_interests: v.shared_interests, action: v.action, can_message: v.can_message }
    : null;
}
function readCard(v: unknown): ReaderCard | null {
  return isObject(v) && str(v.public_id) && str(v.display_name) && str(v.industry) && strs(v.interests) && num(v.verified_count) && bool(v.can_message)
    ? { public_id: v.public_id, display_name: v.display_name, industry: v.industry, interests: v.interests, verified_count: v.verified_count, can_message: v.can_message }
    : null;
}
function readMessage(v: unknown): MessageView | null {
  return isObject(v) && str(v.id) && (v.from === 'me' || v.from === 'them') && str(v.subject) && str(v.body) && str(v.created_at) && bool(v.read)
    ? { id: v.id, from: v.from, subject: v.subject, body: v.body, created_at: v.created_at, read: v.read }
    : null;
}
const STATES = ['request', 'open', 'pending', 'expired', 'declined', 'gone'];
function readConversation(v: unknown): ConversationView | null {
  if (!isObject(v) || !str(v.id) || !STATES.includes(v.state as string) || (v.role !== 'initiator' && v.role !== 'recipient') || !isObject(v.other)) return null;
  const o = v.other;
  if (!(o.public_id === null || str(o.public_id)) || !str(o.display_name) || !(o.industry === null || str(o.industry)) || !strs(o.interests) || !bool(o.deleted)) return null;
  if (!(v.article_id === null || str(v.article_id)) || !str(v.created_at) || !str(v.last_message_at) || !num(v.unread)) return null;
  const last = v.last_message === null ? null : readMessage(v.last_message);
  if (v.last_message !== null && last === null) return null;
  return {
    id: v.id, state: v.state as ConversationView['state'], role: v.role,
    other: { public_id: o.public_id as string | null, display_name: o.display_name, industry: o.industry as string | null, interests: o.interests, deleted: o.deleted },
    article_id: v.article_id as string | null, created_at: v.created_at, last_message_at: v.last_message_at, unread: v.unread, last_message: last,
  };
}
function readList<T>(v: unknown, read: (item: unknown) => T | null): T[] | null {
  if (!Array.isArray(v)) return null;
  const out: T[] = [];
  for (const item of v) {
    const r = read(item);
    if (r === null) return null;
    out.push(r);
  }
  return out;
}

/** The server's social routes. Anything it cannot be sure of is 'failed'; a refusal keeps the server's code. Tokens are never logged. */
export function createSocialApi(baseUrl: string, getToken: () => Promise<string | null>, fetchFn: Fetch = fetch, timeoutMs = TIMEOUT_MS): SocialApi {
  const root = baseUrl.replace(/\/+$/, '');

  async function call<T>(method: string, path: string, body: unknown, parse: (json: unknown) => T | null): Promise<SocialResult<T>> {
    const token = await getToken().catch(() => null);
    if (!token) return { kind: 'unauthorized' };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
      if (body !== undefined) headers['Content-Type'] = 'application/json';
      const res = await fetchFn(`${root}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: controller.signal });
      if (res.status === 401) return { kind: 'unauthorized' };
      if ([400, 403, 404, 409, 429].includes(res.status)) {
        let code = '';
        try {
          const b: unknown = await res.json();
          if (isObject(b) && str(b.error)) code = b.error;
        } catch {
          // a refusal without a readable reason is still a refusal
        }
        return { kind: 'refused', status: res.status, code };
      }
      if (res.status === 204) return { kind: 'ok', value: parse(null) as T };
      if (res.status !== 200) return { kind: 'failed' };
      const value = parse(await res.json());
      return value === null ? { kind: 'failed' } : { kind: 'ok', value };
    } catch {
      return { kind: 'failed' };
    } finally {
      clearTimeout(timer);
    }
  }
  const nothing = () => null as null;
  const id = encodeURIComponent;

  return {
    getSettings: () => call('GET', '/me/messaging-settings', undefined, readSettings),
    putSettings: (patch) => call('PUT', '/me/messaging-settings', patch, readSettings),
    readers: (articleId) =>
      call('GET', `/articles/${id(articleId)}/readers`, undefined, (j) => {
        if (!isObject(j) || !num(j.count)) return null;
        const readers = readList(j.readers, readReader);
        return readers === null ? null : { count: j.count, readers };
      }),
    card: (publicId) => call('GET', `/readers/${id(publicId)}`, undefined, readCard),
    blocks: () =>
      call('GET', '/me/blocks', undefined, (j) =>
        isObject(j) ? readList(j.blocks, (b) => (isObject(b) && str(b.public_id) && str(b.display_name) && str(b.blocked_at) ? { public_id: b.public_id, display_name: b.display_name, blocked_at: b.blocked_at } : null)) : null,
      ),
    block: (publicId) => call('POST', '/me/blocks', { public_id: publicId }, nothing),
    unblock: (publicId) => call('DELETE', `/me/blocks/${id(publicId)}`, undefined, nothing),
    report: (r) =>
      call(
        'POST',
        '/me/reports',
        {
          ...(r.publicId !== undefined ? { public_id: r.publicId } : {}),
          ...(r.messageId !== undefined ? { message_id: r.messageId } : {}),
          reason: r.reason,
          ...(r.note !== undefined && r.note.trim() !== '' ? { note: r.note.trim() } : {}),
          ...(r.articleId !== undefined ? { article_id: r.articleId } : {}),
          ...(r.alsoBlock ? { also_block: true } : {}),
        },
        nothing,
      ),
    send: (s) =>
      call(
        'POST',
        '/me/messages',
        { ...(s.to !== undefined ? { to: s.to } : {}), ...(s.conversationId !== undefined ? { conversation_id: s.conversationId } : {}), subject: s.subject, body: s.body, ...(s.articleId !== undefined ? { article_id: s.articleId } : {}) },
        nothing,
      ),
    inbox: () =>
      call('GET', '/me/inbox', undefined, (j) => {
        if (!isObject(j) || !num(j.cursor) || !num(j.unread)) return null;
        const requests = readList(j.requests, readConversation);
        const conversations = readList(j.conversations, readConversation);
        const sent = readList(j.sent, readConversation);
        return requests && conversations && sent ? { cursor: j.cursor, unread: j.unread, requests, conversations, sent } : null;
      }),
    thread: (conversationId) =>
      call('GET', `/me/conversations/${id(conversationId)}`, undefined, (j) => {
        const view = readConversation(j);
        const messages = isObject(j) ? readList(j.messages, readMessage) : null;
        return view && messages ? { ...view, messages } : null;
      }),
    accept: (conversationId) => call('POST', `/me/conversations/${id(conversationId)}/accept`, undefined, nothing),
    decline: (conversationId) => call('POST', `/me/conversations/${id(conversationId)}/decline`, undefined, nothing),
    markRead: (messageId) => call('POST', `/me/messages/${id(messageId)}/read`, undefined, nothing),
    hide: (messageId) => call('DELETE', `/me/messages/${id(messageId)}`, undefined, nothing),
  };
}
