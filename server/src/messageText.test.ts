// What a message may contain: text only, no links, no attachments, nothing hidden in control characters.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkMessageText } from './messageText.ts';

const ok = (subject: unknown, body: unknown) => checkMessageText(subject, body);

test('plain text is accepted, trimmed, and a subject is optional', () => {
  assert.deepEqual(ok('  Hello  ', '  I enjoyed your take on agents.  '), { ok: true, subject: 'Hello', body: 'I enjoyed your take on agents.' });
  assert.deepEqual(ok(undefined, 'Hi there'), { ok: true, subject: '', body: 'Hi there' });
  assert.deepEqual(ok('', 'Hi there'), { ok: true, subject: '', body: 'Hi there' });
});

test('line breaks and tabs are fine in the body; other control characters are not', () => {
  assert.equal(ok('s', 'one\n\ntwo\tthree\r\nfour').ok, true);
  for (const bad of ['a\u0000b', 'a\u0007b', 'a\u001bb', 'a‮b']) assert.equal(ok('s', bad).ok, false, JSON.stringify(bad)); // the last one reverses how text is shown
  assert.equal(ok('line\nbreak', 'x').ok, false); // a subject is one line
});

test('lengths: a subject up to 120 characters, a body of 1 to 2000, counted as people count them', () => {
  assert.equal(ok('x'.repeat(120), 'b').ok, true);
  assert.equal(ok('x'.repeat(121), 'b').ok, false);
  assert.equal(ok('s', 'b'.repeat(2000)).ok, true);
  assert.equal(ok('s', 'b'.repeat(2001)).ok, false);
  assert.equal(ok('s', '').ok, false);
  assert.equal(ok('s', '   \n  ').ok, false);
  assert.equal(ok('😀'.repeat(120), '😀'.repeat(2000)).ok, true); // an emoji is one character, not two
});

test('only strings are accepted', () => {
  for (const bad of [5, null, {}, [], true]) {
    assert.equal(ok('s', bad).ok, false, `body ${JSON.stringify(bad)}`);
    assert.equal(ok(bad, 'b').ok, false, `subject ${JSON.stringify(bad)}`);
  }
});

test('Scenario: Links are refused, in the body and in the subject, whichever way they are written', () => {
  const links = [
    'see https://example.com/a', 'http://x.y', 'HTTPS://EXAMPLE.COM', 'ftp://files.example.org', 'ssh://host', 'www.example.com', 'WWW.thing.net',
    'example.com', 'visit acme.io/pricing', 'my site is cool.ai', 'try foo.app today', 'a.b.co', 'mailto:me@x.y', 'javascript:alert(1)', 'tel:+15555550100',
    'data:text/html;base64,AAAA', 'file:///etc/passwd', 'write to me@example.com', 'me@example.org', 'bit.ly/abc', 'tinyurl.com/x', 'discord.gg/abc',
  ];
  for (const link of links) {
    const inBody = ok('s', `Hello ${link} bye`);
    assert.equal(inBody.ok, false, link);
    assert.equal(ok(link, 'Hello').ok, false, `subject: ${link}`);
    if (!inBody.ok) assert.equal(inBody.error, 'no links');
  }
});

test('ordinary writing that merely looks a little like a link is accepted', () => {
  const fine = [
    'I read it in Node.js and Next.js docs', 'version 1.2.3 shipped', 'about 3.5 times faster', 'e.g. this, i.e. that', 'U.S. regulators',
    'Dr. Smith said so.', 'See section 4.2 of the paper', 'ratio is 0.75', 'It cost $3.99.', 'the file.txt was big', 'Mr.Jones', 'so... what now?',
    'hello.world', 'a.b', 'I use .NET and C# daily', 'GPT-4.5 is out', 'visit us in Paris, France.Thanks', 'price: 10.50 euro',
  ];
  for (const text of fine) assert.equal(ok('s', text).ok, true, text);
});
