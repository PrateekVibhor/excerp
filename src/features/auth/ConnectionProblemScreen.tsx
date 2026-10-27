import { useState } from 'react';
import { StateButton } from '../feed/FeedStatus';
import { GateScreen } from './GateScreen';
import { useAuth } from './useAuth';

/** The server could not be reached. This is not a refusal, and the words say so. */
export function ConnectionProblemScreen() {
  const auth = useAuth();
  const [trying, setTrying] = useState(false);
  if (!auth) return null;

  const tryAgain = async () => {
    if (trying) return;
    setTrying(true);
    try {
      await auth.checkAgain();
    } finally {
      setTrying(false);
    }
  };

  return (
    <GateScreen title="Couldn't reach the server" body="Check your connection and try again. This is not about your account.">
      <StateButton label={trying ? 'Trying…' : 'Try again'} onPress={tryAgain} primary />
    </GateScreen>
  );
}
