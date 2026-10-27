import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { bottomClear } from '../theme';

/** How much to leave under the last row (or the error line) of a screen that sits under the floating tab bar: the device's bottom safe area plus the shared room for the bar. */
export function useBottomClear(): number {
  return useSafeAreaInsets().bottom + bottomClear;
}
