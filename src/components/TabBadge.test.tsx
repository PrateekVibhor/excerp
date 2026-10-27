import { act, create } from 'react-test-renderer';
import { withSequence } from 'react-native-reanimated';
import { TabBadge } from './TabBadge';

jest.mock('react-native-worklets', () => require('react-native-worklets/lib/module/mock'));
jest.mock('react-native-reanimated', () => {
  const mock = require('react-native-reanimated/mock');
  return { ...mock, withSequence: jest.fn(mock.withSequence) };
});

const text = (r: ReturnType<typeof create>) => JSON.stringify(r.toJSON());

function mount(count: number) {
  let renderer!: ReturnType<typeof create>;
  act(() => {
    renderer = create(<TabBadge count={count} />);
  });
  return renderer;
}

beforeEach(() => (withSequence as jest.Mock).mockClear());

describe('TabBadge', () => {
  it('renders nothing at zero', () => {
    expect(mount(0).toJSON()).toBeNull();
  });

  it('shows the count', () => {
    expect(text(mount(3))).toContain('"3"');
  });

  it('caps at 99+', () => {
    expect(text(mount(150))).toContain('99+');
  });

  it('can be capped lower and placed elsewhere, for the inbox button', () => {
    let renderer!: ReturnType<typeof create>;
    act(() => {
      renderer = create(<TabBadge count={11} max={9} placement={{ top: -7, right: -9 }} />);
    });
    const json = text(renderer);
    expect(json).toContain('9+');
    expect(json).not.toContain('"11"');
    expect(json).toContain('"top":-7');
    expect(json).toContain('"right":-9');
    expect(json).not.toContain('"left":60'); // the tab bar's own position is replaced
  });

  it('does not pop on first render', () => {
    mount(5);
    expect(withSequence).not.toHaveBeenCalled();
  });

  it('pops when the count rises', () => {
    const r = mount(0);
    act(() => r.update(<TabBadge count={1} />));
    expect(withSequence).toHaveBeenCalledTimes(1);
    act(() => r.update(<TabBadge count={2} />));
    expect(withSequence).toHaveBeenCalledTimes(2);
  });

  it('does not pop when the count drops, and disappears at zero', () => {
    const r = mount(2);
    act(() => r.update(<TabBadge count={1} />));
    expect(withSequence).not.toHaveBeenCalled();
    act(() => r.update(<TabBadge count={0} />));
    expect(r.toJSON()).toBeNull();
  });
});
