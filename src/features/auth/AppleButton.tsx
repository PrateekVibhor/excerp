import { StyleSheet } from 'react-native';

/**
 * Apple's own "Sign in with Apple" button. Apple's guidelines ask for its button, not a look-alike, so it is the native one. The library is loaded only when this is drawn, which is
 * only on an iPhone that offers Sign in with Apple. White with an outline and pill-shaped, to sit beside the Google button.
 */
export function AppleButton({ onPress, disabled }: { onPress(): void; disabled?: boolean }) {
  const apple = require('expo-apple-authentication') as typeof import('expo-apple-authentication');
  return (
    <apple.AppleAuthenticationButton
      testID="sign-in-with-apple"
      buttonType={apple.AppleAuthenticationButtonType.SIGN_IN}
      buttonStyle={apple.AppleAuthenticationButtonStyle.WHITE_OUTLINE}
      cornerRadius={24}
      style={[styles.button, disabled && styles.busy]}
      onPress={disabled ? () => {} : onPress}
    />
  );
}

const styles = StyleSheet.create({
  button: { height: 48, width: '100%' },
  busy: { opacity: 0.6 },
});
