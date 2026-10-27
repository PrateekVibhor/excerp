import { SafeAreaProvider } from 'react-native-safe-area-context';
import { Text } from 'react-native';
import { act, create } from 'react-test-renderer';
import { Toast } from './Toast';

jest.mock('react-native-reanimated', () => require('react-native-reanimated/mock'));
jest.mock('react-native-worklets', () => require('react-native-worklets/lib/module/mock'));

const metrics = { frame: { x: 0, y: 0, width: 375, height: 667 }, insets: { top: 47, left: 0, right: 0, bottom: 0 } };
function mount(message: string | null) {
  let renderer!: ReturnType<typeof create>;
  act(() => {
    renderer = create(
      <SafeAreaProvider initialMetrics={metrics}>
        <Toast message={message} />
      </SafeAreaProvider>,
    );
  });
  return renderer;
}

describe('Toast', () => {
  it('renders nothing without a message', () => {
    expect(JSON.stringify(mount(null).toJSON())).not.toContain('alert');
    expect(mount(null).root.findAllByType(Text)).toHaveLength(0);
  });

  it('shows the message, below the status bar, without catching touches', () => {
    const renderer = mount('InMail sent to Maya Chen');
    expect(renderer.root.findAllByType(Text).map((t) => t.props.children)).toEqual(['InMail sent to Maya Chen']);
    const json = JSON.stringify(renderer.toJSON());
    expect(json).toContain('"top":55'); // 47 + 8
    expect(json).toContain('"accessibilityRole":"alert"');
    expect(renderer.root.findAll((n) => n.props.pointerEvents === 'none').length).toBeGreaterThan(0);
  });

  it('follows the message as it changes', () => {
    const renderer = mount('first');
    act(() =>
      renderer.update(
        <SafeAreaProvider initialMetrics={metrics}>
          <Toast message="second" />
        </SafeAreaProvider>,
      ),
    );
    expect(renderer.root.findAllByType(Text).map((t) => t.props.children)).toEqual(['second']);
  });
});
