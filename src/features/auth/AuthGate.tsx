import type { ReactNode } from 'react';
import { ActivityIndicator, StyleSheet, View } from 'react-native';
import { colors } from '../../theme';
import { ConnectionProblemScreen } from './ConnectionProblemScreen';
import { SignInScreen } from './SignInScreen';
import { useAuth } from './useAuth';
import { WaitingScreen } from './WaitingScreen';

/**
 * Shows the app only once the reader is approved; until then a sign-in, waiting or connection-problem screen, and
 * nothing of the app behind it. With no AuthProvider (mock data, or a build with sign-in not set up) it shows the app.
 */
export function AuthGate({ children }: { children: ReactNode }) {
  const auth = useAuth();
  if (!auth) return <>{children}</>;
  switch (auth.state.kind) {
    case 'approved':
      return <>{children}</>;
    case 'signedOut':
      return <SignInScreen />;
    case 'pending':
      return <WaitingScreen />;
    case 'connectionProblem':
      return <ConnectionProblemScreen />;
    case 'loading':
      return (
        <View style={styles.center}>
          <ActivityIndicator color={colors.text.secondary} />
        </View>
      );
  }
}

const styles = StyleSheet.create({ center: { flex: 1, alignItems: 'center', justifyContent: 'center' } });
