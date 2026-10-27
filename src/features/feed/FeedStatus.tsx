import type { ReactNode } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { colors, feed, statePanel, typography } from '../../theme';

/** Dashed panel that stands in for the card stack when there is no card to show. */
export function StatePanel({ children }: { children: ReactNode }) {
  return <View style={styles.panel}>{children}</View>;
}

export function StateButton({
  label,
  onPress,
  primary = false,
}: {
  label: string;
  onPress: () => void;
  primary?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      style={[
        styles.button,
        primary
          ? { backgroundColor: colors.statePanel.primaryBg }
          : { backgroundColor: colors.statePanel.secondaryBg, borderWidth: 1, borderColor: colors.statePanel.secondaryBorder },
      ]}
    >
      <Text
        style={[
          primary ? typography.stateButtonPrimary : typography.stateButton,
          { color: primary ? colors.statePanel.primaryText : colors.text.primary },
        ]}
      >
        {label}
      </Text>
    </Pressable>
  );
}

export function LoadingState() {
  return (
    <StatePanel>
      <ActivityIndicator color={colors.text.secondary} />
      <Text style={[typography.stateBody, { color: colors.statePanel.body }]}>Loading your feed</Text>
    </StatePanel>
  );
}

export function ErrorState({ onRetry }: { onRetry: () => void }) {
  return (
    <StatePanel>
      <Text style={[typography.stateTitle, { color: colors.text.primary }]}>Couldn't load your feed</Text>
      <Text style={[typography.stateBody, styles.centered, { color: colors.statePanel.body }]}>
        Check your connection and try again.
      </Text>
      <View style={styles.buttons}>
        <StateButton label="Retry" onPress={onRetry} primary />
      </View>
    </StatePanel>
  );
}

const styles = StyleSheet.create({
  panel: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: feed.stackPeek,
    borderRadius: statePanel.radius,
    borderWidth: 1,
    borderStyle: 'dashed',
    borderColor: colors.statePanel.border,
    alignItems: 'center',
    justifyContent: 'center',
    gap: statePanel.gap,
    padding: statePanel.padding,
  },
  centered: { textAlign: 'center' },
  buttons: { flexDirection: 'row', gap: statePanel.buttonGap, marginTop: statePanel.buttonsMarginTop },
  button: {
    minHeight: statePanel.buttonHeight,
    paddingVertical: 6,
    paddingHorizontal: statePanel.buttonPaddingH,
    borderRadius: 999,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
