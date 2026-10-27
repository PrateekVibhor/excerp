import { StyleSheet, Text, View } from 'react-native';
import { colors, typography } from '../theme';

export function PlaceholderScreen({ title }: { title: string }) {
  return (
    <View style={styles.root}>
      <Text style={styles.title}>{title}</Text>
      <Text style={styles.body}>Nothing here yet</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 6 },
  title: { ...typography.placeholderTitle, color: colors.text.primary },
  body: { ...typography.placeholderBody, color: colors.text.tertiary },
});
