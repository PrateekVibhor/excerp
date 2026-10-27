import { StyleSheet, Text, View } from 'react-native';
import { colors, list, typography } from '../../theme';

export function EmptyState() {
  return (
    <View style={styles.root}>
      <Text style={[typography.emptyTitle, { color: colors.text.primary }]}>Nothing saved yet</Text>
      <Text style={[typography.stateBody, styles.body, { color: colors.list.emptyBody }]}>
        Swipe right on a card in Discover to save it here.
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { marginTop: list.emptyTop, alignItems: 'center', gap: list.emptyGap },
  body: { textAlign: 'center' },
});
