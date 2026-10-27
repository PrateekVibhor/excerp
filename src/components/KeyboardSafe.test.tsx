import { Keyboard, KeyboardAvoidingView, Platform, ScrollView, Text, TextInput, View } from 'react-native';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { KeyboardSafeScroll, KeyboardSafeView, useKeyboardVisible } from './KeyboardSafe';

type Handler = () => void;
const handlers = new Map<string, Handler[]>();
const emit = (name: string) => act(async () => void (handlers.get(name) ?? []).forEach((h) => h()));
const setOs = (os: string) => Object.defineProperty(Platform, 'OS', { value: os, configurable: true });

beforeEach(() => {
  handlers.clear();
  jest.spyOn(Keyboard, 'addListener').mockImplementation(((name: string, fn: Handler) => {
    handlers.set(name, [...(handlers.get(name) ?? []), fn]);
    return { remove: () => handlers.set(name, (handlers.get(name) ?? []).filter((h) => h !== fn)) };
  }) as never);
  setOs('ios');
});
afterEach(() => {
  jest.restoreAllMocks();
  jest.useRealTimers();
  setOs('ios');
});

const mount = async (node: React.ReactElement) => {
  let r!: ReactTestRenderer;
  await act(async () => { r = create(node); });
  return r;
};
type Measure = (cb: (x: number, y: number, w: number, h: number) => void) => void;
const box = (y: number, h: number): Measure => (cb) => cb(0, y, 375, h);
/** In the test renderer a View's and ScrollView's native methods are plain mocks on the component class; give them real answers. */
const nativeMethods = (view: Measure, scroll: Measure, scrollTo: jest.Mock) => {
  (View as unknown as { prototype: Record<string, unknown> }).prototype.measureInWindow = function (this: unknown, cb: Parameters<Measure>[0]) { view(cb); };
  (ScrollView as unknown as { prototype: Record<string, unknown> }).prototype.measureInWindow = function (this: unknown, cb: Parameters<Measure>[0]) { scroll(cb); };
  (ScrollView as unknown as { prototype: Record<string, unknown> }).prototype.scrollTo = scrollTo;
};

describe('KeyboardSafeScroll', () => {
  it('a drag dismisses the keyboard and a tap on a button works the first time (it is not eaten by the keyboard)', async () => {
    const r = await mount(<KeyboardSafeScroll><Text>x</Text></KeyboardSafeScroll>);
    const scroll = r.root.findByType(ScrollView);
    expect(scroll.props.keyboardDismissMode).toBe('on-drag');
    expect(scroll.props.keyboardShouldPersistTaps).toBe('handled');
    expect(scroll.props.nestedScrollEnabled).toBe(true); // a long multiline field scrolls inside itself
  });

  it('the footer (the button that continues) sits below the scrolling body, not floating over it', async () => {
    const r = await mount(<KeyboardSafeScroll header={<Text>head</Text>} footer={<Text>go</Text>} footerInset={30}><Text>body</Text></KeyboardSafeScroll>);
    const order = r.root.findAllByType(Text).map((t) => t.props.children);
    expect(order).toEqual(['head', 'body', 'go']); // header, body, footer, top to bottom in one column
    const footer = r.root.findAll((n) => n.type === View && n.props.style && !Array.isArray(n.props.style) && 'paddingBottom' in n.props.style)[0];
    expect(footer.props.style.paddingBottom).toBe(30);
    expect(JSON.stringify(footer.props.style)).not.toContain('absolute');
  });

  it('with the keyboard up the footer keeps only a small gap (the home-indicator room is under the keyboard), and gets it back when the keyboard goes', async () => {
    const r = await mount(<KeyboardSafeScroll footer={<Text>go</Text>} footerInset={30}><Text>body</Text></KeyboardSafeScroll>);
    const pad = () => r.root.findAll((n) => n.type === View && n.props.style && !Array.isArray(n.props.style) && 'paddingBottom' in n.props.style)[0].props.style.paddingBottom;
    expect(pad()).toBe(30);
    await emit('keyboardWillShow');
    expect(pad()).toBe(8);
    await emit('keyboardWillHide');
    expect(pad()).toBe(30);
  });

  it('keeps its own props: styles, indicators, and the caller\'s onScroll still run', async () => {
    const onScroll = jest.fn();
    const r = await mount(<KeyboardSafeScroll scrollStyle={{ marginTop: 5 }} contentContainerStyle={{ padding: 3 }} showsVerticalScrollIndicator={false} onScroll={onScroll}><Text>x</Text></KeyboardSafeScroll>);
    const scroll = r.root.findByType(ScrollView);
    expect(scroll.props.showsVerticalScrollIndicator).toBe(false);
    expect(scroll.props.contentContainerStyle).toEqual({ padding: 3 });
    await act(async () => scroll.props.onScroll({ nativeEvent: { contentOffset: { y: 40 } } }));
    expect(onScroll).toHaveBeenCalledTimes(1);
  });
});

describe('KeyboardSafeView', () => {
  it('lifts its content above the keyboard: padding on iOS, height on Android', async () => {
    expect((await mount(<KeyboardSafeView><Text>x</Text></KeyboardSafeView>)).root.findByType(KeyboardAvoidingView).props.behavior).toBe('padding');
    setOs('android');
    expect((await mount(<KeyboardSafeView><Text>x</Text></KeyboardSafeView>)).root.findByType(KeyboardAvoidingView).props.behavior).toBe('height');
  });

  it('knows how far from the top of the screen it sits, so a header above it does not leave the field under the keyboard', async () => {
    nativeMethods(box(132, 600), box(0, 0), jest.fn());
    const r = await mount(<KeyboardSafeView><Text>x</Text></KeyboardSafeView>);
    const outer = r.root.findAll((n) => typeof n.props.onLayout === 'function' && n.type === View)[0];
    await act(async () => outer.props.onLayout({}));
    expect(r.root.findByType(KeyboardAvoidingView).props.keyboardVerticalOffset).toBe(132);
  });
});

describe('KeyboardSafeScroll inside something that already lifts it', () => {
  it('with lift off it adds no keyboard avoiding of its own', async () => {
    const r = await mount(<KeyboardSafeScroll lift={false}><Text>x</Text></KeyboardSafeScroll>);
    expect(r.root.findAllByType(KeyboardAvoidingView)).toHaveLength(0);
    expect(r.root.findByType(ScrollView).props.keyboardDismissMode).toBe('on-drag');
  });
});

describe('bringing the focused field into view', () => {
  const setup = async (field: { y: number; h: number }, body = { y: 100, h: 300 }) => {
    jest.useFakeTimers();
    const scrollTo = jest.fn();
    nativeMethods(box(0, 700), box(body.y, body.h), scrollTo);
    (TextInput as unknown as { State: object }).State = { currentlyFocusedInput: () => ({ measureInWindow: box(field.y, field.h) }) };
    const r = await mount(<KeyboardSafeScroll><Text>x</Text></KeyboardSafeScroll>);
    return { r, scrollTo };
  };
  const settle = async () => { await emit('keyboardDidShow'); await act(async () => void jest.advanceTimersByTime(200)); };

  it('a field under the keyboard (below the visible body) is scrolled up into view', async () => {
    const { scrollTo } = await setup({ y: 380, h: 150 });
    await settle();
    expect(scrollTo).toHaveBeenCalledTimes(1);
    expect(scrollTo.mock.calls[0][0]).toEqual({ y: 380 + 150 - (100 + 300 - 16), animated: true }); // its bottom edge ends a margin above the keyboard
  });

  it('a field taller than the room is aligned by its top, never scrolled out of sight', async () => {
    const { scrollTo } = await setup({ y: 400, h: 500 });
    await settle();
    expect(scrollTo.mock.calls[0][0].y).toBe(400 - (100 + 16));
  });

  it('a field already in view is left alone', async () => {
    const { scrollTo } = await setup({ y: 150, h: 100 });
    await settle();
    expect(scrollTo).not.toHaveBeenCalled();
  });

  it('with no field focused nothing happens', async () => {
    jest.useFakeTimers();
    const scrollTo = jest.fn();
    nativeMethods(box(0, 700), box(100, 300), scrollTo);
    (TextInput as unknown as { State: object }).State = { currentlyFocusedInput: () => null };
    await mount(<KeyboardSafeScroll><Text>x</Text></KeyboardSafeScroll>);
    await settle();
    expect(scrollTo).not.toHaveBeenCalled();
  });
});

describe('useKeyboardVisible', () => {
  function Probe({ out }: { out: { visible: boolean } }) {
    out.visible = useKeyboardVisible();
    return null;
  }
  it('is true while the keyboard is up, on either platform, and stops listening when unmounted', async () => {
    for (const os of ['ios', 'android']) {
      setOs(os);
      handlers.clear();
      const out = { visible: false };
      const r = await mount(<Probe out={out} />);
      const [show, hide] = os === 'ios' ? ['keyboardWillShow', 'keyboardWillHide'] : ['keyboardDidShow', 'keyboardDidHide'];
      await emit(show);
      expect(out.visible).toBe(true);
      await emit(hide);
      expect(out.visible).toBe(false);
      await act(async () => r.unmount());
      expect([...handlers.values()].flat()).toEqual([]);
    }
  });
});
