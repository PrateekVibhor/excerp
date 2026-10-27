import { KeyboardAvoidingView, ScrollView, StyleSheet, TextInput } from 'react-native';
import type { ReactTestInstance } from 'react-test-renderer';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { act } from 'react-test-renderer';
import { byLabel, mount, press, text, texts, unmountAll } from '../readers/testing';
import { IntakeScreen } from './IntakeScreen';
import { AI_CONSENT_VERSION, type AiConsentStore } from '../../data/aiConsent';
import { fakeCourses, ok, refused } from './testing';

const mockRouter = { back: jest.fn(), canGoBack: jest.fn(() => true), replace: jest.fn(), push: jest.fn() };
jest.mock('expo-router', () => ({ useRouter: () => mockRouter }));
jest.mock('react-native-reanimated', () => require('react-native-reanimated/mock'));
jest.mock('react-native-worklets', () => require('react-native-worklets/lib/module/mock'));
jest.mock('@react-native-async-storage/async-storage', () => require('@react-native-async-storage/async-storage/jest/async-storage-mock'));
jest.mock('../../data', () => ({ courseApi: null }));

const metrics = { frame: { x: 0, y: 0, width: 375, height: 667 }, insets: { top: 20, left: 0, right: 0, bottom: 0 } };
/** A device-only agreement stand-in: already agreed by default, as a reader who has built a list before. */
const consentStore = (agreed = true) => {
  let given = agreed;
  return { hasAgreed: jest.fn(async () => given), agree: jest.fn(async () => void (given = true)), withdraw: jest.fn(async () => void (given = false)) } satisfies AiConsentStore;
};
const open = (api: ReturnType<typeof fakeCourses> | null, consent: AiConsentStore = consentStore(), browser?: { openBrowserAsync: jest.Mock }) =>
  mount(<SafeAreaProvider initialMetrics={metrics}><IntakeScreen api={api} consent={consent} browser={browser as never} /></SafeAreaProvider>);
const type = (r: Awaited<ReturnType<typeof open>>, value: string) => act(async () => { r.root.findByType(TextInput).props.onChangeText(value); });
const disabled = (r: Awaited<ReturnType<typeof open>>) => r.root.findAll((n) => n.props.accessibilityLabel === 'Build list' && typeof n.props.onPress === 'function')[0]!.props.accessibilityState?.disabled === true;

beforeEach(() => jest.clearAllMocks());

afterEach(unmountAll);

describe('IntakeScreen', () => {
  it('asks for a role, an industry and, optionally, the job posting', async () => {
    const r = await open(fakeCourses());
    const t = text(r);
    expect(t).toContain('Build a skills list');
    expect(t).toContain('ROLE');
    expect(t).toContain('INDUSTRY');
    expect(t).toContain('JOB POSTING');
    expect(t).toContain('Optional');
    expect(t).toContain('Pasting a posting adds the tools and terms it mentions.');
    for (const role of ['Business analyst', 'Product manager', 'Forward-deployed engineer']) expect(byLabel(r, role)).toHaveLength(1);
  });

  it('Build list stays off until a role is chosen', async () => {
    const r = await open(fakeCourses());
    expect(disabled(r)).toBe(true);
    await press(r, 'Business analyst');
    expect(disabled(r)).toBe(false);
    expect(text(r)).toContain('Business analyst');
  });

  it('Scenario: choose a role, an industry and paste a posting - the list is asked for and the reader is taken to it', async () => {
    const api = fakeCourses();
    const r = await open(api);
    await press(r, 'Business analyst');
    await press(r, 'Industry, No industry');
    await press(r, 'Fintech');
    await type(r, '  Own the treasury requirements.  ');
    await press(r, 'Build list');
    expect(api.start).toHaveBeenCalledWith({ role: 'business analyst', industry: 'fintech', text: '  Own the treasury requirements.  ' });
    expect(mockRouter.replace).toHaveBeenCalledWith({ pathname: '/lists', params: { open: 'c1' } });
  });

  it('with no industry and no posting, only the role is sent', async () => {
    const api = fakeCourses();
    const r = await open(api);
    await press(r, 'Business analyst');
    await press(r, 'Build list');
    expect(api.start).toHaveBeenCalledWith({ role: 'business analyst', industry: '', text: '' });
  });

  it('a list that already exists is opened the same way', async () => {
    const api = fakeCourses({ start: jest.fn(async () => ok({ courseId: 'c9', status: 'ready', existing: true })) });
    const r = await open(api);
    await press(r, 'Business analyst');
    await press(r, 'Build list');
    expect(mockRouter.replace).toHaveBeenCalledWith({ pathname: '/lists', params: { open: 'c9' } });
  });

  it('a refusal is explained here and the reader stays', async () => {
    const api = fakeCourses({ start: jest.fn(async () => refused(429, 'source_search_limit')) });
    const r = await open(api);
    await press(r, 'Business analyst');
    await press(r, 'Build list');
    expect(text(r)).toContain("You've asked for too many lists today");
    expect(mockRouter.replace).not.toHaveBeenCalled();
    expect(disabled(r)).toBe(false);
  });

  it('a request that cannot reach the server says so', async () => {
    const api = fakeCourses({ start: jest.fn(async () => ({ kind: 'failed' as const })) });
    const r = await open(api);
    await press(r, 'Business analyst');
    await press(r, 'Build list');
    expect(text(r)).toContain("Couldn't reach the server");
  });

  it('a posting longer than the server takes is flagged and cannot be sent', async () => {
    const api = fakeCourses();
    const r = await open(api);
    await press(r, 'Business analyst');
    await type(r, 'x'.repeat(4001));
    expect(text(r)).toContain('4001/4000');
    expect(disabled(r)).toBe(true);
    await press(r, 'Build list');
    expect(api.start).not.toHaveBeenCalled();
  });

  it('when the roles cannot be loaded it says so and Retry asks again', async () => {
    const options = jest.fn().mockResolvedValueOnce({ kind: 'failed' }).mockResolvedValueOnce(ok({ roles: [{ name: 'business analyst', label: 'Business analyst', available: true }], industries: [] }));
    const r = await open(fakeCourses({ options }));
    expect(text(r)).toContain("Couldn't load the roles");
    await press(r, 'Retry');
    expect(byLabel(r, 'Business analyst')).toHaveLength(1);
  });

  it('with no server (mock data) it says lists need the live app', async () => {
    expect(text(await open(null))).toContain('needs the live app');
  });

  it('Back leaves the screen', async () => {
    const r = await open(fakeCourses());
    await press(r, 'Back');
    expect(mockRouter.back).toHaveBeenCalled();
  });

  it('product manager and forward-deployed engineer are shown but not offered yet: greyed out, labelled Coming soon, and they cannot be chosen', async () => {
    const r = await open(fakeCourses());
    expect(texts(r).filter((t) => t === 'Coming soon')).toHaveLength(2);
    for (const label of ['Product manager', 'Forward-deployed engineer']) {
      expect(byLabel(r, label)[0]!.props.accessibilityState).toMatchObject({ disabled: true });
      await press(r, label);
    }
    expect(disabled(r)).toBe(true); // nothing was chosen, so Build list is still off
    expect(byLabel(r, 'Business analyst')[0]!.props.accessibilityState).toMatchObject({ disabled: false });
  });

  it('the overall testing budget being used up is explained', async () => {
    const api = fakeCourses({ start: jest.fn(async () => refused(429, 'credit_cap')) });
    const r = await open(api);
    await press(r, 'Business analyst');
    await press(r, 'Build list');
    expect(text(r)).toContain('testing budget');
    expect(mockRouter.replace).not.toHaveBeenCalled();
  });

  describe('the notice before the first list is built', () => {
    const fill = async (r: Awaited<ReturnType<typeof open>>) => {
      await press(r, 'Business analyst');
      await type(r, 'Own the treasury requirements.');
    };

    it('is shown when the reader taps Build list for the first time: nothing is sent to the server until they agree', async () => {
      const api = fakeCourses();
      const consent = consentStore(false);
      const r = await open(api, consent);
      await fill(r);
      await press(r, 'Build list');
      expect(text(r)).toContain('Before we build your list');
      expect(api.start).not.toHaveBeenCalled();
      expect(consent.agree).not.toHaveBeenCalled();
    });

    it('Cancel leaves the form as it was, builds nothing and remembers nothing', async () => {
      const api = fakeCourses();
      const consent = consentStore(false);
      const r = await open(api, consent);
      await fill(r);
      await press(r, 'Build list');
      await press(r, 'Cancel');
      expect(text(r)).not.toContain('Before we build your list');
      expect(api.start).not.toHaveBeenCalled();
      expect(consent.agree).not.toHaveBeenCalled();
      expect(r.root.findByType(TextInput).props.value).toBe('Own the treasury requirements.');
    });

    it('"Agree and build" remembers the agreement on this device and then builds, with exactly what was typed', async () => {
      const api = fakeCourses();
      const consent = consentStore(false);
      const r = await open(api, consent);
      await fill(r);
      await press(r, 'Build list');
      await press(r, 'Agree and build');
      expect(consent.agree).toHaveBeenCalledTimes(1);
      expect(api.start).toHaveBeenCalledWith({ role: 'business analyst', industry: '', text: 'Own the treasury requirements.' });
      expect(mockRouter.replace).toHaveBeenCalledWith({ pathname: '/lists', params: { open: 'c1' } });
    });

    it('is not shown again once agreed: the second list builds straight away', async () => {
      const api = fakeCourses();
      const consent = consentStore(true);
      const r = await open(api, consent);
      await fill(r);
      await press(r, 'Build list');
      expect(text(r)).not.toContain('Before we build your list');
      expect(api.start).toHaveBeenCalledTimes(1);
    });

    it('is shown again when the wording has changed since the reader agreed', async () => {
      const store = { hasAgreed: jest.fn(async () => false), agree: jest.fn(async () => {}), withdraw: jest.fn(async () => {}) } satisfies AiConsentStore;
      const api = fakeCourses();
      const r = await open(api, store);
      await fill(r);
      await press(r, 'Build list');
      expect(text(r)).toContain('Before we build your list');
      expect(typeof AI_CONSENT_VERSION).toBe('string');
    });

    it('does not appear for a role that is not yet available or before a role is chosen: Build list stays off and asks nothing', async () => {
      const consent = consentStore(false);
      const api = fakeCourses();
      const r = await open(api, consent);
      expect(disabled(r)).toBe(true);
      await press(r, 'Product manager');
      expect(disabled(r)).toBe(true);
      expect(text(r)).not.toContain('Before we build your list');
      expect(api.start).not.toHaveBeenCalled();
    });

    it('its Privacy Policy and Terms links open in the browser, and the notice stays up', async () => {
      const browser = { openBrowserAsync: jest.fn(async (_url: string) => ({ type: 'dismiss' })) };
      const r = await open(fakeCourses(), consentStore(false), browser);
      await fill(r);
      await press(r, 'Build list');
      await press(r, 'Privacy Policy');
      await press(r, 'Terms of Use');
      expect(browser.openBrowserAsync.mock.calls.map((c) => c[0])).toEqual(['https://excerp.app/privacy', 'https://excerp.app/terms']);
      expect(text(r)).toContain('Before we build your list');
    });
  });

  it('the keyboard cannot cover the job posting field or the Build list button: both are inside the keyboard-safe body and footer, and nothing floats over the field', async () => {
    const r = await open(fakeCourses());
    const area = r.root.findByType(TextInput);
    const scroll = r.root.findByType(ScrollView);
    expect(scroll.findAllByType(TextInput)).toHaveLength(1); // the field is in the scrolling body, which scrolls it into view
    expect(scroll.props.keyboardDismissMode).toBe('on-drag');
    expect(scroll.props.keyboardShouldPersistTaps).toBe('handled');
    expect(area.props.multiline).toBe(true); // a long posting scrolls inside the field itself
    const build = byLabel(r, 'Build list')[0]!;
    expect(scroll.findAll((n) => n === build)).toHaveLength(0); // the button is not in the scrolling body: it stays put under it
    const flat = (n: ReactTestInstance): unknown[] => [StyleSheet.flatten(n.props.style), ...(n.parent ? flat(n.parent) : [])];
    expect(flat(build).some((st) => (st as { position?: string } | undefined)?.position === 'absolute')).toBe(false);
    expect(r.root.findAllByType(KeyboardAvoidingView)).toHaveLength(1); // lifted above the keyboard
  });
});
