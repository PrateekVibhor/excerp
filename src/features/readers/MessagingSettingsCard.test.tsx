import { MessagingSettingsCard } from './MessagingSettingsCard';
import { byLabel, fakeSocial, mount, OFF, ok, press, refused, switchOf, text, toggle } from './testing';

const mockRouter = { push: jest.fn() };
jest.mock('expo-router', () => ({ useRouter: () => mockRouter }));
jest.mock('@react-native-async-storage/async-storage', () => require('@react-native-async-storage/async-storage/jest/async-storage-mock'));
jest.mock('../../data', () => ({ socialApi: null }));

const CONFIRMED = { adult_confirmed: true, terms_accepted: true };
const browser = () => ({ openBrowserAsync: jest.fn(async () => ({ type: 'dismiss' })) });

beforeEach(() => mockRouter.push.mockClear());

describe('MessagingSettingsCard', () => {
  it('is nothing at all with no server to talk to (mock data)', async () => {
    expect((await mount(<MessagingSettingsCard social={null} />)).toJSON()).toBeNull();
  });

  it('Scenario: both switches are off to begin with, and messages need visibility first', async () => {
    const r = await mount(<MessagingSettingsCard social={fakeSocial()} />);
    expect(switchOf(r, 'Show me as reading').props.value).toBe(false);
    expect(switchOf(r, 'Allow message requests').props.value).toBe(false);
    expect(switchOf(r, 'Allow message requests').props.disabled).toBe(true);
    expect(text(r)).toContain('READERS & MESSAGES');
    expect(text(r)).toContain('Turn on “Show me as reading” first.');
  });

  it('Scenario: the first time, turning visibility on asks the reader to confirm they are 18 or older and accept the Terms - and sends nothing until they do', async () => {
    const social = fakeSocial({ putSettings: jest.fn(async () => ok({ ...OFF, discoverable: true, ...CONFIRMED })) });
    const r = await mount(<MessagingSettingsCard social={social} />);
    await toggle(r, 'Show me as reading', true);
    expect(social.putSettings).not.toHaveBeenCalled();
    expect(text(r)).toContain('Before you turn this on');
    expect(text(r)).toContain('18 or older');
    expect(switchOf(r, 'Show me as reading').props.value).toBe(false); // still off until confirmed
    await press(r, "I'm 18 or older and accept the Terms");
    expect(social.putSettings).toHaveBeenCalledWith({ discoverable: true, confirm_adult: true, accept_terms: true });
    expect(switchOf(r, 'Show me as reading').props.value).toBe(true);
    expect(text(r)).not.toContain('Before you turn this on');
  });

  it('cancelling the question changes nothing', async () => {
    const social = fakeSocial();
    const r = await mount(<MessagingSettingsCard social={social} />);
    await toggle(r, 'Show me as reading', true);
    await press(r, 'Cancel');
    expect(social.putSettings).not.toHaveBeenCalled();
    expect(text(r)).not.toContain('Before you turn this on');
    expect(switchOf(r, 'Show me as reading').props.value).toBe(false);
  });

  it('once confirmed, switches change straight away, with no question, and turning off is just as direct', async () => {
    const social = fakeSocial({
      getSettings: jest.fn(async () => ok({ ...OFF, discoverable: true, ...CONFIRMED })),
      putSettings: jest.fn(async (p) => ok({ ...OFF, discoverable: true, accepts_messages: p.accepts_messages ?? false, ...CONFIRMED })),
    });
    const r = await mount(<MessagingSettingsCard social={social} />);
    expect(switchOf(r, 'Allow message requests').props.disabled).toBe(false);
    await toggle(r, 'Allow message requests', true);
    expect(social.putSettings).toHaveBeenLastCalledWith({ accepts_messages: true });
    expect(text(r)).not.toContain('Before you turn this on');
    await toggle(r, 'Allow message requests', false);
    expect(social.putSettings).toHaveBeenLastCalledWith({ accepts_messages: false });
  });

  it('Scenario: the server says no - the reader is told why in plain words, and the switch stays as the server has it', async () => {
    const social = fakeSocial({ putSettings: jest.fn(async () => refused(400, 'profile required')) });
    const r = await mount(<MessagingSettingsCard social={social} />);
    await toggle(r, 'Show me as reading', true);
    await press(r, "I'm 18 or older and accept the Terms");
    expect(text(r)).toContain('Save your profile first');
    expect(switchOf(r, 'Show me as reading').props.value).toBe(false);
    expect(text(r)).not.toContain('profile required'); // not the server's own wording
  });

  it('a failure to reach the server is said too', async () => {
    const social = fakeSocial({ putSettings: jest.fn(async () => ({ kind: 'failed' as const })) });
    const r = await mount(<MessagingSettingsCard social={social} />);
    await toggle(r, 'Show me as reading', true);
    await press(r, "I'm 18 or older and accept the Terms");
    expect(text(r)).toContain("Couldn't reach the server");
  });

  it('when the settings cannot be loaded the switches are off limits and the card says so', async () => {
    const social = fakeSocial({ getSettings: jest.fn(async () => ({ kind: 'failed' as const })) });
    const r = await mount(<MessagingSettingsCard social={social} />);
    expect(text(r)).toContain("Couldn't load these settings");
    expect(switchOf(r, 'Show me as reading').props.disabled).toBe(true);
  });

  it('has a way to the blocked readers; the Terms and Privacy Policy are linked in the consent question, and at the bottom of Profile, not in this card', async () => {
    const r = await mount(<MessagingSettingsCard social={fakeSocial()} />);
    await press(r, 'Blocked readers');
    expect(mockRouter.push).toHaveBeenCalledWith('/blocked');
    expect(byLabel(r, 'Terms of Use')).toHaveLength(0);
    await toggle(r, 'Show me as reading', true);
    expect(byLabel(r, 'Terms of Use').length).toBeGreaterThan(0); // in the question the reader is asked
    expect(byLabel(r, 'Privacy Policy').length).toBeGreaterThan(0);
  });
});
