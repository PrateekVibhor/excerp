import type { ReactTestInstance } from 'react-test-renderer';
import { act, create } from 'react-test-renderer';
import { emptyInbox, loadedStore } from '../readers/testing';
import { EnvelopeButton } from './EnvelopeButton';

const mockRouter = { push: jest.fn() };
jest.mock('expo-router', () => ({ useRouter: () => mockRouter }));
jest.mock('../../data', () => ({ inboxStore: null }));
jest.mock('react-native-reanimated', () => require('react-native-reanimated/mock'));
jest.mock('react-native-worklets', () => require('react-native-worklets/lib/module/mock'));
jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);

async function mount(count: number) {
  let renderer!: ReturnType<typeof create>;
  const store = await loadedStore(emptyInbox({ unread: count }));
  await act(async () => {
    renderer = create(<EnvelopeButton store={store} />);
  });
  const button = () =>
    renderer.root.findAll((n: ReactTestInstance) => n.props.accessibilityRole === 'button' && typeof n.props.onPress === 'function')[0];
  return { renderer, button, text: () => JSON.stringify(renderer.toJSON()) };
}

beforeEach(() => mockRouter.push.mockClear());

describe('EnvelopeButton', () => {
  it('shows no badge at zero', async () => {
    const { text, button } = await mount(0);
    expect(button().props.accessibilityLabel).toBe('Inbox');
    expect(text()).not.toContain('"0"');
  });

  it('Scenario: Badge count - shows the number of unread messages up to 9', async () => {
    for (const n of [1, 2, 9]) {
      const { text, button } = await mount(n);
      expect(text()).toContain(`"${n}"`);
      expect(button().props.accessibilityLabel).toBe(`Inbox, ${n} unread`);
    }
  });

  it('Scenario: Badge count - 11 unread shows "9+", while screen readers hear the real number', async () => {
    const { text, button } = await mount(11);
    expect(text()).toContain('9+');
    expect(text()).not.toContain('"11"');
    expect(button().props.accessibilityLabel).toBe('Inbox, 11 unread');
    expect(text()).toContain('9+');
    expect((await mount(10)).text()).toContain('9+');
  });

  it('opens the inbox when pressed', async () => {
    const { button } = await mount(2);
    act(() => button().props.onPress());
    expect(mockRouter.push).toHaveBeenCalledWith('/inbox');
  });
});
