import { approveMessage, buildFailedMessage, CANCELLED_NOTE, cancelMessage, deleteMessage, refreshFailedMessage, renameMessage, startMessage } from './courseMessages';

describe('what the reader is told when the server says no', () => {
  it('starting: a limit says when to try again, an unavailable role says so, anything else is plain', () => {
    expect(startMessage({ kind: 'refused', status: 429, code: 'source_search_limit' })).toMatch(/too many|limit/i);
    expect(startMessage({ kind: 'refused', status: 429, code: 'source_search_cap' })).toMatch(/busy|later/i);
    expect(startMessage({ kind: 'refused', status: 400, code: 'list_mode_unavailable' })).toMatch(/isn't available/i);
    expect(startMessage({ kind: 'refused', status: 400, code: 'text_too_long' })).toMatch(/shorter/i);
    expect(startMessage({ kind: 'refused', status: 409, code: 'course_withdrawn' })).toMatch(/no longer available/i);
    expect(startMessage({ kind: 'refused', status: 503, code: 'courses_off' })).toMatch(/paused|unavailable/i);
    expect(startMessage({ kind: 'refused', status: 400, code: 'something_new' })).toMatch(/couldn't start/i);
    expect(startMessage({ kind: 'failed' })).toMatch(/couldn't reach the server/i);
  });
  it('approving: the daily and monthly limit, too few postings, and a plain fallback', () => {
    expect(approveMessage({ kind: 'refused', status: 429, code: 'course_limit' })).toMatch(/one new course a day|three a month/i);
    expect(approveMessage({ kind: 'refused', status: 429, code: 'generation_cap' })).toMatch(/busy|later/i);
    expect(approveMessage({ kind: 'refused', status: 409, code: 'not_enough_postings' })).toMatch(/enough job postings/i);
    expect(approveMessage({ kind: 'refused', status: 409, code: 'no_source' })).toMatch(/paste/i);
    expect(approveMessage({ kind: 'refused', status: 409, code: 'whatever' })).toMatch(/couldn't start building/i);
    expect(approveMessage({ kind: 'failed' })).toMatch(/couldn't reach the server/i);
  });
  it('a build that failed', () => {
    expect(buildFailedMessage('failed')).toMatch(/couldn't build/i);
    expect(buildFailedMessage('withdrawn')).toMatch(/no longer available/i);
  });
});

describe('the testing budget and the list actions', () => {
  it('the overall budget being used up is explained when asking for a list and when approving one', () => {
    expect(startMessage({ kind: 'refused', status: 429, code: 'credit_cap' })).toMatch(/testing budget/i);
    expect(approveMessage({ kind: 'refused', status: 429, code: 'credit_cap' })).toMatch(/testing budget/i);
  });
  it('a name that cannot be used, and a list that could not be renamed, deleted or checked', () => {
    expect(renameMessage({ kind: 'refused', status: 400, code: 'invalid_title' })).toMatch(/1 and 80 characters/);
    expect(renameMessage({ kind: 'failed' })).toMatch(/couldn't reach the server/i);
    expect(renameMessage({ kind: 'refused', status: 404, code: '' })).toMatch(/isn't there any more/i);
    expect(deleteMessage({ kind: 'failed' })).toMatch(/couldn't reach the server/i);
    expect(deleteMessage({ kind: 'refused', status: 404, code: '' })).toMatch(/isn't there any more/i);
    expect(refreshFailedMessage({ kind: 'failed' })).toMatch(/couldn't reach the server/i);
    expect(refreshFailedMessage({ kind: 'refused', status: 404, code: '' })).toMatch(/isn't there any more/i);
    expect(refreshFailedMessage({ kind: 'refused', status: 503, code: 'courses_off' })).toMatch(/paused/i);
  });
});

describe('stopping a build', () => {
  it('a stopped list is told calmly, with what to do next', () => {
    expect(CANCELLED_NOTE).toBe('You stopped this list. Delete it or start a new one.');
  });
  it('a stop that did not work says what is true: no connection, our trouble, or a plain refusal', () => {
    expect(cancelMessage({ kind: 'failed' })).toMatch(/couldn't reach the server/i);
    expect(cancelMessage({ kind: 'failed', server: true })).toMatch(/something went wrong on our side/i);
    expect(cancelMessage({ kind: 'refused', status: 403, code: 'x' })).toMatch(/couldn't stop the list/i);
  });
});
