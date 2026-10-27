import { BlurView } from 'expo-blur';
import { Tabs } from 'expo-router';
import { ComponentProps } from 'react';
import { Pressable, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Svg, { Circle, Path, Rect } from 'react-native-svg';
import { useNewCoverage } from '../features/courses/useNewCoverage';
import { useSavedCount } from '../features/readingList/useSavedCount';
import { blur, colors, radius, tab, tabBar, typography } from '../theme';
import { useKeyboardVisible } from './KeyboardSafe';
import { TabBadge } from './TabBadge';

type TabBarRenderer = NonNullable<ComponentProps<typeof Tabs>['tabBar']>;
type BottomTabBarProps = Parameters<TabBarRenderer>[0];

type IconProps = { color: string };

function FeedIcon({ color }: IconProps) {
  return (
    <Svg width={tab.iconSize} height={tab.iconSize} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={tab.iconStroke} strokeLinecap="round" strokeLinejoin="round">
      <Rect x="4" y="3" width="16" height="18" rx="4" />
      <Path d="M8 16.5h8" />
    </Svg>
  );
}

function BookmarkIcon({ color }: IconProps) {
  return (
    <Svg width={tab.iconSize} height={tab.iconSize} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={tab.iconStroke} strokeLinecap="round" strokeLinejoin="round">
      <Path d="M6 4.5A1.5 1.5 0 0 1 7.5 3h9A1.5 1.5 0 0 1 18 4.5V21l-6-4.5L6 21z" />
    </Svg>
  );
}

function ProfileIcon({ color }: IconProps) {
  return (
    <Svg width={tab.iconSize} height={tab.iconSize} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={tab.iconStroke} strokeLinecap="round" strokeLinejoin="round">
      <Circle cx="12" cy="8" r="3.5" />
      <Path d="M5 20c0-3.9 3.1-6 7-6s7 2.1 7 6" />
    </Svg>
  );
}

function ListIcon({ color }: IconProps) {
  return (
    <Svg width={tab.iconSize} height={tab.iconSize} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={tab.iconStroke} strokeLinecap="round" strokeLinejoin="round">
      <Path d="M9 6.5h10.5M9 12h10.5M9 17.5h10.5" />
      <Path d="M4.5 6.5h.01M4.5 12h.01M4.5 17.5h.01" />
    </Svg>
  );
}

const icons: Record<string, (p: IconProps) => React.JSX.Element> = {
  feed: FeedIcon,
  'reading-list': BookmarkIcon,
  profile: ProfileIcon,
  lists: ListIcon,
};

const labels: Record<string, string> = { feed: 'Feed', 'reading-list': 'Reading List', profile: 'Profile', lists: 'Skills list' };

/** How wide each tab is: its full size where the screen allows, and narrower where it does not, so the bar always fits with a margin each side. */
export function tabWidth(screenWidth: number, count: number): number {
  const room = screenWidth - tabBar.sideMargin * 2 - tabBar.padding * 2 - (count - 1) * tabBar.gap;
  return Math.min(tab.width, Math.floor(room / count));
}

export function GlassTabBar({ state, navigation }: BottomTabBarProps) {
  const insets = useSafeAreaInsets();
  const keyboard = useKeyboardVisible();
  const badges: Record<string, number> = { 'reading-list': useSavedCount() };
  const newCoverage = useNewCoverage();
  const { width: screenWidth } = useWindowDimensions();
  const width = tabWidth(screenWidth, state.routes.length);

  // The floating bar is drawn over the screen; with the keyboard up it would sit over the field being typed in (on Android it rides up above the keyboard), so it steps aside.
  if (keyboard) return null;

  return (
    <View
      pointerEvents="box-none"
      style={[styles.wrap, { bottom: insets.bottom + tabBar.bottomOffset }]}
    >
      <View style={styles.bar}>
        <BlurView intensity={blur.tabBar} tint={blur.tint} style={StyleSheet.absoluteFill} />
        <View style={[StyleSheet.absoluteFill, styles.tint]} />
        <View style={styles.row}>
          {state.routes.map((route, index) => {
            const focused = state.index === index;
            const color = focused ? colors.text.primary : colors.text.tabInactive;
            const Icon = icons[route.name];
            const onPress = () => {
              const event = navigation.emit({ type: 'tabPress', target: route.key, canPreventDefault: true });
              if (!focused && !event.defaultPrevented) navigation.navigate(route.name);
            };
            return (
              <Pressable
                key={route.key}
                accessibilityRole="tab"
                accessibilityState={{ selected: focused }}
                onPress={onPress}
                style={[styles.tab, { width }, focused && styles.tabActive]}
              >
                {Icon && <Icon color={color} />}
                <Text numberOfLines={1} adjustsFontSizeToFit style={[styles.label, { color }]}>{labels[route.name] ?? route.name}</Text>
                {badges[route.name] !== undefined && <TabBadge count={badges[route.name]} />}
                {route.name === 'lists' && newCoverage && <View accessible accessibilityLabel="New coverage" style={styles.dot} />}
              </Pressable>
            );
          })}
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { position: 'absolute', left: 0, right: 0, alignItems: 'center' },
  bar: {
    borderRadius: radius.pill,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: colors.border.tabBar,
    shadowColor: colors.shadow.tabBar,
    shadowOpacity: 1,
    shadowRadius: 24,
    shadowOffset: { width: 0, height: 10 },
  },
  tint: { backgroundColor: colors.glass.tabBar },
  row: { flexDirection: 'row', gap: tabBar.gap, padding: tabBar.padding },
  tab: {
    height: tab.height,
    borderRadius: radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 3,
  },
  tabActive: { backgroundColor: colors.glass.tabActive },
  dot: { position: 'absolute', top: 7, right: '28%', width: 9, height: 9, borderRadius: 5, backgroundColor: colors.badge.bg, borderWidth: 1.5, borderColor: colors.badge.ring },
  label: { ...typography.tabLabel },
});
