import { useFonts } from 'expo-font';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { ScreenBackground } from '../src/components/ScreenBackground';
import { AuthGate } from '../src/features/auth/AuthGate';
import { AuthProvider } from '../src/features/auth/AuthProvider';
import { authDeps, e2eEnabled } from '../src/features/auth/authConfig';
import { accountScope, accountSync, deviceIdRepository, syncQueue } from '../src/data';
import { IntroGate } from '../src/features/intro/IntroGate';
import { AccountSync } from '../src/features/auth/AccountSync';
import { SyncNotice } from '../src/features/auth/SyncNotice';
import { useSyncOnLaunch } from '../src/features/leaderboard/useSyncOnLaunch';
import { QUIZ_SCREEN_OPTIONS } from '../src/features/quiz/quizRoute';
import { fontAssets } from '../src/theme';

// Only the end-to-end test build has this; the flag is fixed at build time, and without it the stand-in is never loaded.
const FakeGoogleSheet = e2eEnabled ? (require('../src/features/auth/fakeGoogle') as typeof import('../src/features/auth/fakeGoogle')).FakeGoogleSheet : null;

// What account deletion needs from this device: the id to tell the server, and a way to forget it and the unsent verifications.
const leaderboardIdentity = {
  deviceId: deviceIdRepository.get,
  hold: syncQueue.hold,
  forget: async () => {
    await deviceIdRepository.forget();
    await syncQueue.clear();
    await accountSync.detach(); // the server's side is gone: what the phone knew about it is forgotten, and nothing uploads until the reader does something new
  },
};

export default function RootLayout() {
  const [loaded, error] = useFonts(fontAssets);
  useSyncOnLaunch(); // verifications left waiting from an earlier run

  // On a load error, render anyway so the system font is used instead of a blank screen.
  if (!loaded && !error) return null;

  // The article screen sits above the tabs; screens draw their own background where they must be opaque.
  const app = (
    // The intro cards sit inside the sign-in gate (this is what it shows), so they never cover the sign-in screen.
    <IntroGate>
      <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: 'transparent' } }}>
        {/* The quiz covers the article and cannot be swiped away mid-question; its own Back pill leaves it. */}
        <Stack.Screen name="quiz/[id]" options={QUIZ_SCREEN_OPTIONS} />
      </Stack>
    </IntroGate>
  );

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <ScreenBackground>
          {/* With sign-in set up, nothing of the app shows until the server has approved the reader. */}
          {authDeps ? (
            <AuthProvider {...authDeps} identity={leaderboardIdentity} account={accountScope}>
              <AccountSync />
              <AuthGate>{app}</AuthGate>
              <SyncNotice />
            </AuthProvider>
          ) : (
            app
          )}
        </ScreenBackground>
        {FakeGoogleSheet && <FakeGoogleSheet />}
        <StatusBar style="dark" />
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
