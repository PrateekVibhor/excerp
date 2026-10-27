import { SafeAreaProvider } from 'react-native-safe-area-context';
import { act, create } from 'react-test-renderer';
import { bottomClear } from '../theme';
import { useBottomClear } from './useBottomClear';

describe('useBottomClear', () => {
  it('is the device bottom safe area plus the shared room under the floating tab bar', async () => {
    const seen: number[] = [];
    function Probe() {
      seen.push(useBottomClear());
      return null;
    }
    for (const bottom of [0, 34]) {
      await act(async () => {
        create(<SafeAreaProvider initialMetrics={{ frame: { x: 0, y: 0, width: 390, height: 844 }, insets: { top: 47, left: 0, right: 0, bottom } }}><Probe /></SafeAreaProvider>);
      });
    }
    expect(seen.slice(-1)[0]).toBe(34 + bottomClear);
    expect(seen).toContain(bottomClear);
  });
});
