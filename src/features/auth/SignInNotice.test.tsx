import { Text } from 'react-native';
import { act, create, type ReactTestInstance } from 'react-test-renderer';
import { SignInNotice } from './SignInNotice';

const words = (r: ReturnType<typeof create>) => r.root.findAllByType(Text).map((t) => [t.props.children].flat().join('')).join(' | ');

describe('SignInNotice', () => {
  it('Scenario: before signing in the reader is told what is kept, that skips are counted, and where to read more', async () => {
    let r!: ReturnType<typeof create>;
    await act(async () => { r = create(<SignInNotice />); });
    const text = words(r);
    expect(text).toContain('profile');
    expect(text).toContain('saved');
    expect(text).toContain('verified');
    expect(text).toContain('skip');
    expect(text).toContain('Google or Apple account');
  });

  it('it links to the privacy policy', async () => {
    const browser = { openBrowserAsync: jest.fn(async () => ({ type: 'dismiss' })) };
    let r!: ReturnType<typeof create>;
    await act(async () => { r = create(<SignInNotice browser={browser as never} />); });
    const link = r.root.findAll((n: ReactTestInstance) => n.props.accessibilityRole === 'link' && typeof n.props.onPress === 'function')[0];
    await act(async () => { await link.props.onPress(); });
    expect(browser.openBrowserAsync).toHaveBeenCalledWith('https://excerp.app/privacy');
  });
});
