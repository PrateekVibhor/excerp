import { useEffect, useRef, useState } from 'react';
import { AccessibilityInfo, Pressable, ScrollView, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Svg, { Path } from 'react-native-svg';
import { ScreenBackground } from '../../components/ScreenBackground';
import { colors, detail, font, typography } from '../../theme';
import { INTRO_CARDS } from './introCopy';

const LAST = INTRO_CARDS.length - 1;

/**
 * Three swipeable cards shown when the app opens. Skip is on every card, and so is the "Don't show this again" box; what the reader ticked is handed to `onDone`
 * when they leave, by Skip or Get started, and nothing is decided before then.
 */
export function IntroCards({ onDone }: { onDone: (hideNextTime: boolean) => void }) {
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const pager = useRef<ScrollView>(null);
  const [index, setIndex] = useState(0);
  const [hide, setHide] = useState(false);
  const [reduceMotion, setReduceMotion] = useState(false);

  useEffect(() => {
    let live = true;
    Promise.resolve(AccessibilityInfo.isReduceMotionEnabled?.()).then((v) => live && setReduceMotion(Boolean(v)), () => {});
    return () => {
      live = false;
    };
  }, []);

  const next = () => {
    if (index === LAST) return onDone(hide);
    pager.current?.scrollTo({ x: (index + 1) * width, animated: !reduceMotion });
    setIndex(index + 1);
  };

  return (
    <ScreenBackground>
      <View style={[styles.root, { paddingTop: insets.top + detail.backTop, paddingBottom: Math.max(insets.bottom, 16) }]}>
        <View style={styles.top}>
          <Pressable accessibilityRole="button" accessibilityLabel="Skip" hitSlop={8} onPress={() => onDone(hide)} style={styles.skip}>
            <Text style={[typography.pillButton, { color: colors.text.primary }]}>Skip</Text>
          </Pressable>
        </View>
        <ScrollView
          ref={pager}
          horizontal
          pagingEnabled
          showsHorizontalScrollIndicator={false}
          style={styles.pager}
          onMomentumScrollEnd={(e) => setIndex(Math.max(0, Math.min(LAST, Math.round(e.nativeEvent.contentOffset.x / width))))}
        >
          {INTRO_CARDS.map((card) => (
            <ScrollView key={card.title} style={{ width }} contentContainerStyle={styles.page} showsVerticalScrollIndicator={false}>
              <Text accessibilityRole="header" style={styles.title}>{card.title}</Text>
              <Text style={styles.body}>{card.body}</Text>
            </ScrollView>
          ))}
        </ScrollView>
        <View style={styles.foot}>
          <View accessible accessibilityLabel={`Card ${index + 1} of ${INTRO_CARDS.length}`} style={styles.dots}>
            {INTRO_CARDS.map((card, i) => <View key={card.title} style={[styles.dot, i === index && styles.dotOn]} />)}
          </View>
          <Pressable
            accessibilityRole="checkbox"
            accessibilityLabel="Don't show this again"
            accessibilityState={{ checked: hide }}
            onPress={() => setHide(!hide)}
            style={styles.check}
          >
            <View style={[styles.box, hide && styles.boxOn]}>
              {hide ? <Svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="#ffffff" strokeWidth={3.4} strokeLinecap="round" strokeLinejoin="round"><Path d="M5 12.5l4.5 4.5L19 7.5" /></Svg> : null}
            </View>
            <Text style={styles.checkLabel}>Don't show this again</Text>
          </Pressable>
          <Pressable accessibilityRole="button" accessibilityLabel={index === LAST ? 'Get started' : 'Next'} onPress={next} style={styles.cta}>
            <Text style={styles.ctaText}>{index === LAST ? 'Get started' : 'Next'}</Text>
          </Pressable>
        </View>
      </View>
    </ScreenBackground>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  top: { alignItems: 'flex-end', paddingHorizontal: detail.backSide },
  skip: { minHeight: 44, minWidth: 64, paddingHorizontal: 16, borderRadius: 999, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.detail.backBg, borderWidth: 1, borderColor: colors.detail.backBorder },
  pager: { flex: 1 },
  page: { flexGrow: 1, justifyContent: 'center', paddingHorizontal: 32, paddingVertical: 24, gap: 16 },
  title: { fontFamily: font.sans.semibold, fontSize: 30, lineHeight: 34, letterSpacing: -0.9, color: colors.text.primary },
  body: { fontFamily: font.sans.regular, fontSize: 17, lineHeight: 25, color: colors.course.muted },
  foot: { paddingHorizontal: 24, gap: 8, alignItems: 'stretch' },
  dots: { flexDirection: 'row', justifyContent: 'center', gap: 8, paddingVertical: 8 },
  dot: { width: 8, height: 8, borderRadius: 4, backgroundColor: colors.course.step.idle },
  dotOn: { width: 22, backgroundColor: colors.course.strong.bg },
  check: { minHeight: 48, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 12, paddingVertical: 4 },
  box: { width: 26, height: 26, borderRadius: 8, alignItems: 'center', justifyContent: 'center', borderWidth: 2, borderColor: colors.course.missing.border, backgroundColor: 'rgba(255,255,255,0.7)' },
  boxOn: { borderColor: colors.course.strong.bg, backgroundColor: colors.course.strong.bg },
  checkLabel: { flexShrink: 1, fontFamily: font.sans.regular, fontSize: 15, color: colors.text.primary },
  cta: { minHeight: 54, paddingVertical: 12, paddingHorizontal: 26, borderRadius: 999, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.course.strong.bg },
  ctaText: { fontFamily: font.sans.semibold, fontSize: 16, color: '#ffffff' },
});
