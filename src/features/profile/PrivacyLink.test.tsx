import { StyleSheet, Text } from 'react-native';
import { act, create, type ReactTestInstance } from 'react-test-renderer';
import { colors } from '../../theme';
import { PrivacyLink, PRIVACY_POLICY_URL } from './PrivacyLink';

const render = async (props: Parameters<typeof PrivacyLink>[0] = {}) => {
  let r!: ReturnType<typeof create>;
  await act(async () => { r = create(<PrivacyLink {...props} />); });
  const link = r.root.findAll((n: ReactTestInstance) => n.props.accessibilityLabel === 'Privacy Policy' && typeof n.props.onPress === 'function')[0];
  return { r, link, text: r.root.findAllByType(Text)[0] };
};

describe('PrivacyLink', () => {
  it('Scenario: a small "Privacy Policy" link, announced as a link', async () => {
    const { link, text } = await render();
    expect(text.props.children).toBe('Privacy Policy');
    expect(link.props.accessibilityRole).toBe('link');
  });

  it('opens the policy page: an https address on the app\'s own domain', async () => {
    expect(PRIVACY_POLICY_URL).toBe('https://excerp.app/privacy');
    const browser = { openBrowserAsync: jest.fn().mockResolvedValue({ type: 'dismiss' }) };
    const { link } = await render({ browser });
    await act(async () => { await link.props.onPress(); });
    expect(browser.openBrowserAsync).toHaveBeenCalledTimes(1);
    expect(browser.openBrowserAsync).toHaveBeenCalledWith('https://excerp.app/privacy');
  });

  it('a page that cannot be opened does not crash the screen', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const browser = { openBrowserAsync: jest.fn().mockRejectedValue(new Error('no browser')) };
    const { link } = await render({ browser });
    await expect(act(async () => { await link.props.onPress(); })).resolves.toBeUndefined();
    warn.mockRestore();
  });

  it('is fine print: small, gray (the theme\'s tertiary text), centered and underlined', async () => {
    const style = StyleSheet.flatten((await render()).text.props.style);
    expect(style.fontSize).toBeLessThanOrEqual(13);
    expect(style.color).toBe(colors.text.tertiary);
    expect(style.textAlign).toBe('center');
    expect(style.textDecorationLine).toBe('underline');
  });

  it('is still easy to tap: the touch area is at least 44 points high', async () => {
    const { link } = await render();
    const style = StyleSheet.flatten(link.props.style);
    expect(style.minHeight).toBeGreaterThanOrEqual(44);
  });
});
