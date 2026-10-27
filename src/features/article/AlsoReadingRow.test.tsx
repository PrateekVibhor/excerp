import { act, create } from 'react-test-renderer';
import { byLabel, fakeSocial, mount, OFF, ok, press, reader, refused, text } from '../readers/testing';
import { AlsoReadingRow } from './AlsoReadingRow';

jest.mock('@react-native-async-storage/async-storage', () => require('@react-native-async-storage/async-storage/jest/async-storage-mock'));
jest.mock('../../data', () => ({ socialApi: null }));

const CONFIRMED = { ...OFF, adult_confirmed: true, terms_accepted: true };

describe('AlsoReadingRow', () => {
  it('is nothing at all with no server to ask (mock data)', async () => {
    expect((await mount(<AlsoReadingRow articleId="a1" onOpenReader={jest.fn()} social={null} />)).toJSON()).toBeNull();
  });

  it('Scenario: real readers of this article, with what they did, and each opens that reader', async () => {
    const social = fakeSocial({ readers: jest.fn(async () => ok({ count: 5, readers: [reader(1, { action: 'verified' }), reader(2, { action: 'saved', industry: 'Finance' })] })) });
    const open = jest.fn();
    const r = await mount(<AlsoReadingRow articleId="a1" onOpenReader={open} social={social} />);
    expect(social.readers).toHaveBeenCalledWith('a1');
    for (const t of ['ALSO READING THIS', 'Reader 1', 'Software · Verified it', 'Reader 2', 'Finance · Saved it']) expect(text(r)).toContain(t);
    await press(r, 'Reader 2, Finance');
    expect(open).toHaveBeenCalledWith(reader(2).public_id);
  });

  it('with nobody else to show, or when it cannot be loaded, there is nothing here at all', async () => {
    for (const answer of [ok({ count: 0, readers: [] }), { kind: 'failed' as const }, refused(404, 'article not found')]) {
      const r = await mount(<AlsoReadingRow articleId="a1" onOpenReader={jest.fn()} social={fakeSocial({ readers: jest.fn(async () => answer) })} />);
      expect(r.toJSON()).toBeNull();
    }
  });

  it('the first look is blank, not a spinner or a flicker of wrong content', async () => {
    let finish!: (v: Awaited<ReturnType<ReturnType<typeof fakeSocial>['readers']>>) => void;
    const social = fakeSocial({ readers: jest.fn(() => new Promise((resolve) => { finish = resolve; })) });
    let r!: ReturnType<typeof create>;
    await act(async () => { r = create(<AlsoReadingRow articleId="a1" onOpenReader={jest.fn()} social={social} />); });
    expect(r.toJSON()).toBeNull();
    await act(async () => finish(ok({ count: 3, readers: [reader(1)] })));
    expect(text(r)).toContain('Reader 1');
  });

  it('Scenario: a reader who is not visible is invited to be, and sees nobody else until they are', async () => {
    const social = fakeSocial({ readers: jest.fn(async () => refused(403, 'visibility_required')) });
    const r = await mount(<AlsoReadingRow articleId="a1" onOpenReader={jest.fn()} social={social} />);
    expect(text(r)).toContain('ALSO READING THIS');
    expect(text(r)).toContain('Turn on being seen');
    expect(text(r)).not.toContain('Reader 1');
    expect(byLabel(r, 'Turn on Show me as reading')).toHaveLength(1);
  });

  it('Scenario: turning it on for the first time asks for the 18+ and Terms confirmation, then the readers appear', async () => {
    const readers = jest.fn().mockResolvedValueOnce(refused(403, 'visibility_required')).mockResolvedValueOnce(ok({ count: 4, readers: [reader(1)] }));
    const social = fakeSocial({ readers, getSettings: jest.fn(async () => ok(OFF)), putSettings: jest.fn(async () => ok({ ...CONFIRMED, discoverable: true })) });
    const r = await mount(<AlsoReadingRow articleId="a1" onOpenReader={jest.fn()} social={social} />);
    await press(r, 'Turn on Show me as reading');
    expect(text(r)).toContain('Before you turn this on');
    expect(social.putSettings).not.toHaveBeenCalled();
    await press(r, "I'm 18 or older and accept the Terms");
    expect(social.putSettings).toHaveBeenCalledWith({ discoverable: true, confirm_adult: true, accept_terms: true });
    expect(text(r)).toContain('Reader 1');
    expect(text(r)).not.toContain('Before you turn this on');
  });

  it('once confirmed it turns on straight away, with no question', async () => {
    const readers = jest.fn().mockResolvedValueOnce(refused(403, 'visibility_required')).mockResolvedValueOnce(ok({ count: 3, readers: [reader(1)] }));
    const social = fakeSocial({ readers, getSettings: jest.fn(async () => ok(CONFIRMED)), putSettings: jest.fn(async () => ok({ ...CONFIRMED, discoverable: true })) });
    const r = await mount(<AlsoReadingRow articleId="a1" onOpenReader={jest.fn()} social={social} />);
    await press(r, 'Turn on Show me as reading');
    expect(social.putSettings).toHaveBeenCalledWith({ discoverable: true });
    expect(text(r)).toContain('Reader 1');
  });

  it('if turning it on is refused (no profile yet) the reader is told why and nothing changes', async () => {
    const social = fakeSocial({ readers: jest.fn(async () => refused(403, 'visibility_required')), getSettings: jest.fn(async () => ok(CONFIRMED)), putSettings: jest.fn(async () => refused(400, 'profile required')) });
    const r = await mount(<AlsoReadingRow articleId="a1" onOpenReader={jest.fn()} social={social} />);
    await press(r, 'Turn on Show me as reading');
    expect(text(r)).toContain('Save your profile first');
    expect(social.readers).toHaveBeenCalledTimes(1);
  });
});
