import { StyleSheet, Text } from 'react-native';
import { act, create, type ReactTestInstance } from 'react-test-renderer';
import { colors } from '../../theme';
import { TERMS_URL } from '../readers/links';
import { TermsLink } from './TermsLink';

const render = async (props: Parameters<typeof TermsLink>[0] = {}) => {
  let r!: ReturnType<typeof create>;
  await act(async () => { r = create(<TermsLink {...props} />); });
  const link = r.root.findAll((n: ReactTestInstance) => n.props.accessibilityLabel === 'Terms of Use' && typeof n.props.onPress === 'function')[0];
  return { r, link, text: r.root.findAllByType(Text)[0] };
};

describe('TermsLink', () => {
  it('Scenario: a small "Terms of Use" link, announced as a link', async () => {
    const { link, text } = await render();
    expect(text.props.children).toBe('Terms of Use');
    expect(link.props.accessibilityRole).toBe('link');
  });

  it('opens the terms page, on the app\'s own domain', async () => {
    expect(TERMS_URL).toBe('https://excerp.app/terms');
    const browser = { openBrowserAsync: jest.fn().mockResolvedValue({ type: 'dismiss' }) };
    const { link } = await render({ browser });
    await act(async () => { await link.props.onPress(); });
    expect(browser.openBrowserAsync).toHaveBeenCalledWith('https://excerp.app/terms');
  });

  it('a page that cannot be opened does not crash the screen', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const browser = { openBrowserAsync: jest.fn().mockRejectedValue(new Error('no browser')) };
    const { link } = await render({ browser });
    await expect(act(async () => { await link.props.onPress(); })).resolves.toBeUndefined();
    warn.mockRestore();
  });

  it('looks exactly like the Privacy Policy link next to it: small, gray, underlined, with a touch area at least 44 points high', async () => {
    const { text, link } = await render();
    const style = StyleSheet.flatten(text.props.style);
    expect([style.fontSize, style.color, style.textDecorationLine]).toEqual([12, colors.text.tertiary, 'underline']);
    expect(StyleSheet.flatten(link.props.style).minHeight).toBeGreaterThanOrEqual(44);
  });
});
