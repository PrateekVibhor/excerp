import { StyleSheet } from 'react-native';
import type { ReactTestInstance } from 'react-test-renderer';
import { act, create } from 'react-test-renderer';
import { BottomActionBar } from '../../components/BottomActionBar';
import { StateButton } from '../feed/FeedStatus';
import { ReviewAnswersButton } from './ReviewAnswersButton';
import { TakeQuizButton } from './TakeQuizButton';

jest.mock('react-native-reanimated', () => require('react-native-reanimated/mock'));
jest.mock('react-native-worklets', () => require('react-native-worklets/lib/module/mock'));

const flat = (r: ReturnType<typeof create>, label: string) => {
  const node = r.root.find((n: ReactTestInstance) => n.props.accessibilityLabel === label && typeof n.props.onPress === 'function' && typeof n.type !== 'string');
  return StyleSheet.flatten(node.props.style) as Record<string, unknown>;
};
const mount = (ui: React.ReactElement) => {
  let r!: ReturnType<typeof create>;
  act(() => {
    r = create(ui);
  });
  return r;
};

// With large text the buttons must grow and wrap, not clip or break words apart, so none has a fixed height.
describe('buttons with large text', () => {
  it('"Take quiz" can grow and wraps its second label onto its own line', () => {
    const style = flat(mount(<TakeQuizButton questions={3} onPress={() => {}} />), 'Take quiz');
    expect(style.height).toBeUndefined();
    expect(style.minHeight).toBe(56);
    expect(style.flexWrap).toBe('wrap');
  });

  it('"Verified, review answers" does the same', () => {
    const style = flat(mount(<ReviewAnswersButton onPress={() => {}} />), 'Verified, review answers');
    expect(style.height).toBeUndefined();
    expect(style.minHeight).toBe(56);
    expect(style.flexWrap).toBe('wrap');
  });

  it('the Next bar button and the state buttons grow with their text', () => {
    const bar = flat(mount(<BottomActionBar id="b" label="Next" hint="h" icon={null} bottomInset={0} onPress={() => {}} />), 'Next');
    expect(bar.height).toBeUndefined();
    expect(bar.minHeight).toBe(56);
    const button = flat(mount(<StateButton label="Try again" onPress={() => {}} primary />), 'Try again');
    expect(button.height).toBeUndefined();
    expect(button.minHeight).toBe(44);
  });
});
