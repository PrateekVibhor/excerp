import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Keyboard, KeyboardAvoidingView, Platform, ScrollView, TextInput, View, type NativeScrollEvent, type NativeSyntheticEvent, type ScrollViewProps, type StyleProp, type ViewStyle } from 'react-native';

/**
 * The one way a screen with a text field deals with the keyboard. Every screen or sheet that has a TextInput uses this (a test enforces it):
 *  - KeyboardSafeView lifts what it holds above the keyboard, wherever on the screen it sits (it measures its own distance from the top, which a plain
 *    KeyboardAvoidingView does not). A sheet or dialog in a Modal uses this.
 *  - KeyboardSafeScroll is that plus a scrolling body: the field being typed in is scrolled into view when the keyboard comes up or another field is tapped,
 *    a drag dismisses the keyboard, a tap on a button works the first time, and an optional footer (the button that continues) rides above the keyboard.
 */

/** True while the keyboard is up. The floating tab bar uses it to get out of the way. */
export function useKeyboardVisible(): boolean {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const ios = Platform.OS === 'ios';
    const show = Keyboard.addListener(ios ? 'keyboardWillShow' : 'keyboardDidShow', () => setVisible(true));
    const hide = Keyboard.addListener(ios ? 'keyboardWillHide' : 'keyboardDidHide', () => setVisible(false));
    return () => {
      show.remove();
      hide.remove();
    };
  }, []);
  return visible;
}

export function KeyboardSafeView({ children, style }: { children: ReactNode; style?: StyleProp<ViewStyle> }) {
  const box = useRef<View>(null);
  const [offset, setOffset] = useState(0);
  const measure = useCallback(() => box.current?.measureInWindow((_x, y) => setOffset((was) => (Number.isFinite(y) && y !== was ? y : was))), []);
  // The distance is measured again when the keyboard comes up, in case the screen moved since it was laid out.
  useEffect(() => {
    const show = Keyboard.addListener('keyboardDidShow', measure);
    return () => show.remove();
  }, [measure]);
  return (
    <View ref={box} collapsable={false} onLayout={measure} style={{ flex: 1 }}>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : 'height'} keyboardVerticalOffset={offset} style={style ?? { flex: 1 }}>
        {children}
      </KeyboardAvoidingView>
    </View>
  );
}

const MARGIN = 16;

export function KeyboardSafeScroll({
  children,
  footer,
  footerInset = 0,
  lift = true,
  header,
  style,
  scrollStyle,
  contentContainerStyle,
  ...rest
}: Omit<ScrollViewProps, 'style'> & {
  children: ReactNode;
  /** The button that continues: it stays below the scrolling body and rides above the keyboard. */
  footer?: ReactNode;
  /** Room under the footer when the keyboard is down (the home indicator); with the keyboard up it is already clear of it. */
  footerInset?: number;
  /** False when something around it (a sheet in a KeyboardSafeView) already lifts it; it then only scrolls the field into view. */
  lift?: boolean;
  /** What sits above the body and does not scroll. */
  header?: ReactNode;
  style?: StyleProp<ViewStyle>;
  scrollStyle?: StyleProp<ViewStyle>;
}) {
  const scroll = useRef<ScrollView>(null);
  const offsetY = useRef(0);
  const keyboard = useKeyboardVisible();

  /** Scrolls the field being typed in into the visible part of the body, never pushing its top out of view. */
  const reveal = useCallback(() => {
    const input = (TextInput as unknown as { State?: { currentlyFocusedInput?: () => { measureInWindow: (cb: (x: number, y: number, w: number, h: number) => void) => void } | null } }).State?.currentlyFocusedInput?.();
    const body = scroll.current as unknown as { measureInWindow?: (cb: (x: number, y: number, w: number, h: number) => void) => void; scrollTo: (o: { y: number; animated: boolean }) => void } | null;
    if (!input || !body?.measureInWindow) return;
    body.measureInWindow((_bx, by, _bw, bh) => {
      input.measureInWindow((_ix, iy, _iw, ih) => {
        const top = by + MARGIN;
        const bottom = by + bh - MARGIN;
        let delta = 0;
        if (iy < top) delta = iy - top;
        else if (iy + ih > bottom) delta = Math.min(iy + ih - bottom, iy - top);
        if (delta !== 0) body.scrollTo({ y: Math.max(0, offsetY.current + delta), animated: true });
      });
    });
  }, []);
  const later = useCallback((ms: number) => void setTimeout(reveal, ms), [reveal]);

  useEffect(() => {
    const show = Keyboard.addListener('keyboardDidShow', () => later(60)); // once the layout has settled under the keyboard
    return () => show.remove();
  }, [later]);

  const track = (e: NativeSyntheticEvent<NativeScrollEvent>) => {
    offsetY.current = e.nativeEvent.contentOffset.y;
    rest.onScroll?.(e);
  };

  const Lifted = lift ? KeyboardSafeView : Plain;
  return (
    <Lifted style={style}>
      {header}
      <ScrollView
        ref={scroll}
        style={[{ flex: 1 }, scrollStyle]}
        contentContainerStyle={contentContainerStyle}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        nestedScrollEnabled
        scrollEventThrottle={16}
        {...rest}
        onScroll={track}
        // Tapping into another field while the keyboard is already up moves the focus without a keyboard event: look again once the focus has settled.
        onTouchEnd={(e) => {
          rest.onTouchEnd?.(e);
          later(120);
        }}
      >
        {children}
      </ScrollView>
      {footer ? <View style={{ paddingBottom: keyboard ? 8 : footerInset }}>{footer}</View> : null}
    </Lifted>
  );
}

function Plain({ children, style }: { children: ReactNode; style?: StyleProp<ViewStyle> }) {
  return <View style={style ?? { flex: 1 }}>{children}</View>;
}
