import { useRouter } from 'expo-router';
import { Pressable, StyleSheet, View } from 'react-native';
import Svg, { Path, Rect } from 'react-native-svg';
import { TabBadge } from '../../components/TabBadge';
import { colors, envelope } from '../../theme';
import type { InboxStore } from '../../data/inboxStore';
import { useUnreadCount } from './useUnreadCount';

/** The inbox button in the Profile header: a mail icon with the unread count ("9+" above 9). */
export function EnvelopeButton({ store }: { store?: InboxStore | null }) {
  const router = useRouter();
  const unread = useUnreadCount(store);

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={unread > 0 ? `Inbox, ${unread} unread` : 'Inbox'}
      onPress={() => router.push('/inbox')}
      style={styles.button}
    >
      <Svg
        width={envelope.icon}
        height={envelope.icon}
        viewBox="0 0 24 24"
        fill="none"
        stroke={colors.text.primary}
        strokeWidth={envelope.iconStroke}
        strokeLinejoin="round"
      >
        <Rect x="3" y="5" width="18" height="14" rx="3" />
        <Path d="m4 7 8 6 8-6" />
      </Svg>
      <TabBadge
        count={unread}
        max={envelope.badgeMax}
        placement={{
          top: envelope.badgeTop,
          right: envelope.badgeRight,
          borderWidth: envelope.badgeRing,
          borderColor: colors.badge.ring,
        }}
      />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  button: {
    width: envelope.size,
    height: envelope.size,
    borderRadius: envelope.size / 2,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.detail.backBg,
    borderWidth: 1,
    borderColor: colors.detail.backBorder,
  },
});
