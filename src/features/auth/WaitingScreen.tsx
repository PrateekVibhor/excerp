import { useState } from 'react';
import { Text } from 'react-native';
import { colors, typography } from '../../theme';
import { StateButton } from '../feed/FeedStatus';
import { GateScreen } from './GateScreen';
import { useAuth } from './useAuth';

/** For a reader whose Google account is not on the allow-list (yet). The same words whatever the reason. */
export function WaitingScreen() {
  const auth = useAuth();
  const [checking, setChecking] = useState(false);
  const [checked, setChecked] = useState(false);
  if (!auth) return null;

  const checkAgain = async () => {
    if (checking) return;
    setChecking(true);
    setChecked(false);
    try {
      await auth.checkAgain();
      setChecked(true); // still here afterwards means still not approved
    } finally {
      setChecking(false);
    }
  };

  return (
    <GateScreen title="Waiting for approval" body="Your Google account isn't approved yet. You'll be able to come in as soon as it is.">
      {checked && !checking && (
        <Text accessibilityRole="alert" style={[typography.formHint, { color: colors.statePanel.body }]}>
          Still waiting. Check again later.
        </Text>
      )}
      <StateButton label={checking ? 'Checking…' : 'Check again'} onPress={checkAgain} primary />
      <StateButton label="Use a different account" onPress={() => void auth.signOut()} />
    </GateScreen>
  );
}
