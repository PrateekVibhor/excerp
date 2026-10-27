import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { colors, font, typography } from '../../theme';

export interface MenuItem {
  label: string;
  onPress: () => void;
  /** A smaller line under the label (the time a list was last checked, say). */
  hint?: string;
  destructive?: boolean;
  disabled?: boolean;
}

/** A short menu of actions that rises from the bottom. Pressing an item closes the menu first, then does the action. */
export function ActionMenu({ visible, title, items, onClose }: { visible: boolean; title?: string; items: MenuItem[]; onClose: () => void }) {
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose} statusBarTranslucent>
      <View style={styles.root}>
        <Pressable accessibilityRole="button" accessibilityLabel="Close menu" onPress={onClose} style={styles.backdrop} />
        <View accessibilityViewIsModal style={styles.sheet}>
          {title ? <Text numberOfLines={1} style={styles.title}>{title}</Text> : null}
          {items.map((item) => (
            <Pressable
              key={item.label}
              accessibilityRole="button"
              accessibilityLabel={item.label}
              accessibilityState={{ disabled: item.disabled === true }}
              onPress={() => {
                if (item.disabled) return;
                onClose();
                item.onPress();
              }}
              style={[styles.item, item.disabled && { opacity: 0.45 }]}
            >
              <Text style={[typography.sheetAction, { color: item.destructive ? colors.form.error : colors.text.primary }]}>{item.label}</Text>
              {item.hint ? <Text style={styles.hint}>{item.hint}</Text> : null}
            </Pressable>
          ))}
          <Pressable accessibilityRole="button" accessibilityLabel="Close" onPress={onClose} style={[styles.item, styles.cancel]}>
            <Text style={[typography.sheetAction, { color: colors.sheet.cancel }]}>Close</Text>
          </Pressable>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, justifyContent: 'flex-end' },
  backdrop: { ...StyleSheet.absoluteFill, backgroundColor: colors.sheet.dim },
  sheet: { margin: 12, padding: 8, borderRadius: 24, backgroundColor: colors.sheet.bg, borderWidth: 1, borderColor: colors.sheet.border },
  title: { fontFamily: font.mono.medium, fontSize: 11, letterSpacing: 1.1, color: colors.course.muted, paddingHorizontal: 16, paddingTop: 12, paddingBottom: 6 },
  item: { minHeight: 52, paddingHorizontal: 16, paddingVertical: 10, justifyContent: 'center', gap: 2 },
  hint: { fontFamily: font.sans.regular, fontSize: 12.5, color: colors.course.muted },
  cancel: { borderTopWidth: 1, borderTopColor: colors.form.menuDivider, marginTop: 4 },
});
