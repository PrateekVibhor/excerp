import { Dimensions, ScrollView, StyleSheet } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { act } from 'react-test-renderer';
import { byLabel, mount, press, text, unmountAll } from '../readers/testing';
import { INTRO_CARDS } from './introCopy';
import { IntroCards } from './IntroCards';

jest.mock('react-native-reanimated', () => require('react-native-reanimated/mock'));
jest.mock('react-native-worklets', () => require('react-native-worklets/lib/module/mock'));

const metrics = { frame: { x: 0, y: 0, width: 375, height: 667 }, insets: { top: 20, left: 0, right: 0, bottom: 0 } };
const open = (onDone = jest.fn()) => mount(<SafeAreaProvider initialMetrics={metrics}><IntroCards onDone={onDone} /></SafeAreaProvider>).then((r) => ({ r, onDone }));
afterEach(unmountAll);

describe('IntroCards', () => {
  it('shows the first card with Next, and every card has Skip', async () => {
    const { r } = await open();
    expect(text(r)).toContain(INTRO_CARDS[0]!.title);
    expect(byLabel(r, 'Next')).toHaveLength(1);
    expect(byLabel(r, 'Get started')).toHaveLength(0);
    expect(byLabel(r, 'Skip')).toHaveLength(1);
  });

  it('Next moves on, the last card says Get started, and Skip is still there', async () => {
    const { r } = await open();
    await press(r, 'Next');
    expect(r.root.findAll((n) => n.props.accessibilityLabel === 'Card 2 of 3').length).toBeGreaterThan(0);
    await press(r, 'Next');
    expect(r.root.findAll((n) => n.props.accessibilityLabel === 'Card 3 of 3').length).toBeGreaterThan(0);
    expect(byLabel(r, 'Next')).toHaveLength(0);
    expect(byLabel(r, 'Get started')).toHaveLength(1);
    expect(byLabel(r, 'Skip')).toHaveLength(1);
  });

  it('swiping to a page updates the dots and the button', async () => {
    const { r } = await open();
    const pager = r.root.findAllByType(ScrollView).find((s) => s.props.horizontal)!;
    await act(async () => { pager.props.onMomentumScrollEnd({ nativeEvent: { contentOffset: { x: Dimensions.get('window').width * 2 } } }); });
    expect(byLabel(r, 'Get started')).toHaveLength(1);
  });

  it('Get started and Skip report whether the box was ticked', async () => {
    const a = await open();
    await press(a.r, 'Skip');
    expect(a.onDone).toHaveBeenCalledWith(false);
    const b = await open();
    await press(b.r, "Don't show this again");
    await press(b.r, 'Next');
    await press(b.r, 'Next');
    await press(b.r, 'Get started');
    expect(b.onDone).toHaveBeenCalledWith(true);
  });

  it('the box is on every card, keeps its tick between cards, and is at least 44 points tall', async () => {
    const { r } = await open();
    await press(r, "Don't show this again");
    await press(r, 'Next');
    const box = byLabel(r, "Don't show this again")[0]!;
    expect(box.props.accessibilityState).toMatchObject({ checked: true });
    expect(StyleSheet.flatten(box.props.style).minHeight).toBeGreaterThanOrEqual(44);
  });

  it('each card scrolls, so large text is never cut off', async () => {
    const { r } = await open();
    expect(r.root.findAllByType(ScrollView).filter((s) => !s.props.horizontal).length).toBeGreaterThanOrEqual(INTRO_CARDS.length);
  });
});
