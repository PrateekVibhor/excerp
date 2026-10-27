import type { ReactNode } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { colors, statePanel, typography } from '../../theme';

/** The frame the sign-in, waiting and connection-problem screens share: a title, a line of explanation, then the actions. */
export function GateScreen({ title, body, children }: { title: string; body: string; children?: ReactNode }) {
  const insets = useSafeAreaInsets();
  // The same space above and below, so the group sits in the middle of the screen: padding that follows the status bar at
  // the top and the home indicator at the bottom is unequal and pushes everything down.
  const pad = Math.max(insets.top, insets.bottom) + 24;
  return (
    <View style={[styles.root, { paddingTop: pad, paddingBottom: pad }]}>
      <Text accessibilityRole="header" style={[typography.feedTitle, { color: colors.text.primary }]}>{title}</Text>
      <Text style={[typography.stateBody, styles.body, { color: colors.statePanel.body }]}>{body}</Text>
      <View style={styles.actions}>{children}</View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, justifyContent: 'center', paddingHorizontal: statePanel.padding, gap: statePanel.gap },
  body: { marginBottom: 6 },
  actions: { gap: statePanel.buttonGap, marginTop: statePanel.buttonsMarginTop },
});
