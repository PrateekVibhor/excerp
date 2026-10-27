import { StyleSheet, Text, View } from 'react-native';
import Svg, { Path } from 'react-native-svg';
import { colors, statePanel, typography } from '../../theme';
import { StateButton, StatePanel } from './FeedStatus';

export function AllCaughtUp({
  reviewed,
  savedThisSession,
  onOpenReadingList,
}: {
  reviewed: number;
  savedThisSession: number;
  onOpenReadingList: () => void;
}) {
  return (
    <StatePanel>
      <View style={styles.circle}>
        <Svg
          width={statePanel.icon}
          height={statePanel.icon}
          viewBox="0 0 24 24"
          fill="none"
          stroke={colors.statePanel.check}
          strokeWidth={statePanel.iconStroke}
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <Path d="M20 6 9 17l-5-5" />
        </Svg>
      </View>
      <Text style={[typography.stateTitle, { color: colors.text.primary }]}>You're all caught up</Text>
      {reviewed > 0 && (
        <Text style={[typography.stateBody, styles.centered, { color: colors.statePanel.body }]}>
          {`${reviewed} ${reviewed === 1 ? 'story' : 'stories'} reviewed · ${savedThisSession} saved this session`}
        </Text>
      )}
      <View style={styles.buttons}>
        <StateButton label="Open Reading List" onPress={onOpenReadingList} primary />
      </View>
    </StatePanel>
  );
}

const styles = StyleSheet.create({
  circle: {
    width: statePanel.circle,
    height: statePanel.circle,
    borderRadius: statePanel.circle / 2,
    backgroundColor: colors.statePanel.circleBg,
    borderWidth: 1,
    borderColor: colors.statePanel.circleBorder,
    alignItems: 'center',
    justifyContent: 'center',
  },
  centered: { textAlign: 'center' },
  buttons: { flexDirection: 'row', marginTop: statePanel.buttonsMarginTop },
});
