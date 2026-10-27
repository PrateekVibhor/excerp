import { Pressable, ScrollView, StyleSheet, Text } from 'react-native';
import type { ReactTestInstance } from 'react-test-renderer';
import { bottomClear } from '../../theme';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { act } from 'react-test-renderer';
import { byLabel, mount, text, unmountAll } from '../readers/testing';
import { BuildingScreen } from './BuildingScreen';

jest.mock('react-native-reanimated', () => require('react-native-reanimated/mock'));
jest.mock('react-native-worklets', () => require('react-native-worklets/lib/module/mock'));

const metrics = { frame: { x: 0, y: 0, width: 375, height: 667 }, insets: { top: 20, left: 0, right: 0, bottom: 0 } };
const open = (props: Partial<React.ComponentProps<typeof BuildingScreen>> = {}) =>
  mount(<SafeAreaProvider initialMetrics={metrics}><BuildingScreen role="data engineer" industry="healthcare" stage="reference" percent={62} onBack={jest.fn()} {...props} /></SafeAreaProvider>);

afterEach(unmountAll);

describe('BuildingScreen', () => {
  it('names the role and industry, the title and the percent', async () => {
    const t = text(await open());
    expect(t).toContain('DATA ENGINEER · HEALTHCARE');
    expect(t).toContain('Building your list');
    expect(t).toContain('62%');
  });

  it('with no industry the kicker is the role alone', async () => {
    expect(text(await open({ industry: null }))).toContain('DATA ENGINEER');
    expect(text(await open({ industry: null }))).not.toContain('·');
  });

  it('shows the four steps, each done, in progress or waiting, from the stage', async () => {
    const r = await open({ stage: 'reference' });
    const label = (s: string) => r.root.findAll((n) => n.props.accessibilityLabel === s);
    expect(label('Reading the job posting, done').length).toBeGreaterThan(0);
    expect(label('Listing concepts in order, done').length).toBeGreaterThan(0);
    expect(label('Matching library sources, in progress').length).toBeGreaterThan(0);
    expect(label('Rating coverage, waiting').length).toBeGreaterThan(0);
  });

  it('sets the expectation under the title: about ten to fifteen minutes, so a slow bar does not look stuck', async () => {
    const t = text(await open({ percent: 42 }));
    expect(t).toContain('Building your list, this usually takes about 10 to 15 minutes');
  });

  it('drops the time estimate when there is a problem, since nothing is building', async () => {
    expect(text(await open({ error: 'Something went wrong.' }))).not.toContain('usually takes about 10 to 15 minutes');
  });

  it('tells the reader they can leave, and Back leaves', async () => {
    const onBack = jest.fn();
    const r = await open({ onBack });
    expect(text(r)).toContain("You can leave this screen");
    await act(async () => { byLabel(r, 'Back')[0]!.props.onPress(); });
    expect(onBack).toHaveBeenCalled();
  });

  it('a problem is shown as an alert in place of the reassurance, with the action offered', async () => {
    const onRetry = jest.fn();
    const r = await open({ error: 'You can start one new course a day and three a month. Try again later.', onRetry });
    expect(r.root.findAll((n) => n.props.accessibilityRole === 'alert').length).toBeGreaterThan(0);
    expect(text(r)).toContain('one new course a day');
    expect(text(r)).not.toContain('You can leave this screen');
    await act(async () => { byLabel(r, 'Try again')[0]!.props.onPress(); });
    expect(onRetry).toHaveBeenCalled();
  });

  it('a problem with no way to retry shows no button', async () => {
    expect(byLabel(await open({ error: "We couldn't build this list. Try again later." }), 'Try again')).toHaveLength(0);
  });

  it('inside the tab it shows the tab\'s own buttons in place of Back', async () => {
    const chrome = { title: 'Treasury systems role', left: <Pressable accessibilityRole="button" accessibilityLabel="Open lists" onPress={jest.fn()}><Text>☰</Text></Pressable> };
    const r = await open({ chrome });
    expect(byLabel(r, 'Back')).toHaveLength(0);
    expect(byLabel(r, 'Open lists')).toHaveLength(1);
    expect(text(r)).toContain('Treasury systems role');
  });

  it('a calm note replaces the reassurance and the progress title, is not an alert, and offers no retry', async () => {
    const r = await open({ note: 'You stopped this list. Delete it or start a new one.', onRetry: jest.fn() });
    expect(text(r)).toContain('You stopped this list. Delete it or start a new one.');
    expect(text(r)).not.toContain('Building your list');
    expect(text(r)).not.toContain('You can leave this screen');
    expect(r.root.findAll((n) => n.props.accessibilityRole === 'alert')).toHaveLength(0);
    expect(byLabel(r, 'Try again')).toHaveLength(0);
  });

  describe('the error line and the floating tab bar', () => {
    const metricsBottom = (bottom: number) => ({ frame: { x: 0, y: 0, width: 375, height: 667 }, insets: { top: 20, left: 0, right: 0, bottom } });
    const openWith = (bottom: number, props: Partial<React.ComponentProps<typeof BuildingScreen>> = {}) =>
      mount(<SafeAreaProvider initialMetrics={metricsBottom(bottom)}><BuildingScreen role="data engineer" industry="healthcare" stage="reference" percent={62} onBack={jest.fn()} {...props} /></SafeAreaProvider>);
    const LONG = "We couldn't build this list because the server stopped partway through the work. Please try again in a few minutes, and if it keeps happening, tell us.";

    it('leaves the shared room under the tab bar below everything, so the error line and Try again can scroll fully clear of it, whatever the device', async () => {
      for (const bottom of [0, 34]) {
        const r = await openWith(bottom, { error: LONG, onRetry: jest.fn() });
        expect(StyleSheet.flatten(r.root.findByType(ScrollView).props.contentContainerStyle).paddingBottom).toBe(bottom + bottomClear);
      }
    });

    it('the error line and its button are in the flow of the scrolling body, not pinned to the bottom edge where the bar would cover them', async () => {
      const r = await openWith(34, { error: LONG, onRetry: jest.fn() });
      const body = r.root.findByType(ScrollView);
      const alert = body.findAll((n) => n.props.accessibilityRole === 'alert');
      const retry = body.findAll((n) => n.props.accessibilityLabel === 'Try again' && typeof n.props.onPress === 'function');
      expect(alert.length).toBeGreaterThan(0);
      expect(retry.length).toBeGreaterThan(0);
      const chain = (n: ReactTestInstance): unknown[] => [StyleSheet.flatten(n.props.style), ...(n.parent ? chain(n.parent) : [])];
      for (const n of [...alert, ...retry]) expect(chain(n).some((st) => (st as { position?: string } | undefined)?.position === 'absolute')).toBe(false);
    });

    it('a long error wraps (no line limit, nothing shrinks it) and the button grows with large text instead of clipping it', async () => {
      const r = await openWith(0, { error: LONG, onRetry: jest.fn() });
      const line = r.root.findAll((n) => n.props.accessibilityRole === 'alert' && n.type === Text)[0]!;
      expect(line.props.numberOfLines).toBeUndefined();
      expect(line.props.adjustsFontSizeToFit).toBeUndefined();
      expect(text(r)).toContain(LONG);
      const button = r.root.findAll((n) => n.props.accessibilityLabel === 'Try again' && typeof n.props.onPress === 'function')[0]!;
      const style = StyleSheet.flatten(button.props.style);
      expect(style.height).toBeUndefined(); // a fixed height would clip larger text
      expect(style.minHeight).toBeGreaterThanOrEqual(44);
    });

    it('Try again still works on the first tap', async () => {
      const onRetry = jest.fn();
      const r = await openWith(34, { error: LONG, onRetry });
      await act(async () => { byLabel(r, 'Try again')[0]!.props.onPress(); });
      expect(onRetry).toHaveBeenCalledTimes(1);
    });
  });
});
