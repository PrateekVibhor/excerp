import { act } from 'react-test-renderer';
import { PRIVACY_POLICY_URL } from '../profile/PrivacyLink';
import { TERMS_URL } from '../readers/links';
import { byLabel, mount, text, unmountAll } from '../readers/testing';
import { ConsentDialog } from './ConsentDialog';

afterEach(unmountAll);

const open = (props: Partial<React.ComponentProps<typeof ConsentDialog>> = {}) => {
  const fns = { onAgree: jest.fn(), onCancel: jest.fn(), openLink: jest.fn(async (_url: string) => true) };
  return mount(<ConsentDialog visible {...fns} {...props} />).then((r) => ({ r, ...fns }));
};

describe('ConsentDialog', () => {
  it('says plainly what is sent and to whom: the posting to the AI model, skill names to the web search service, and what is not sent', async () => {
    const { r } = await open();
    const t = text(r);
    expect(t).toContain('Before we build your list');
    expect(t).toMatch(/job posting you paste is sent to an AI language model run by Nebius/);
    expect(t).toMatch(/Skill and tool names taken from it, and the role, are sent to Tavily \(a web search service\)/);
    expect(t).not.toMatch(/YouTube|video/i); // no video search is sent anything in this version
    expect(t).toMatch(/skill and tool names/i);
    expect(t).toMatch(/not your name, email address or account details/i);
    expect(t).toMatch(/never paste anyone else's personal information|do not paste anyone else's personal information/i);
  });

  it('links to the Privacy Policy and the Terms of Use, which open in the browser', async () => {
    const { r, openLink } = await open();
    await act(async () => { byLabel(r, 'Privacy Policy')[0]!.props.onPress(); });
    await act(async () => { byLabel(r, 'Terms of Use')[0]!.props.onPress(); });
    expect(openLink.mock.calls.map((c) => c[0])).toEqual([PRIVACY_POLICY_URL, TERMS_URL]);
  });

  it('agrees only when the reader taps "Agree and build"; Cancel agrees to nothing', async () => {
    const { r, onAgree, onCancel } = await open();
    expect(onAgree).not.toHaveBeenCalled();
    await act(async () => { byLabel(r, 'Cancel')[0]!.props.onPress(); });
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onAgree).not.toHaveBeenCalled();
    await act(async () => { byLabel(r, 'Agree and build')[0]!.props.onPress(); });
    expect(onAgree).toHaveBeenCalledTimes(1);
  });

  it('shows nothing when it is not asked for', async () => {
    const { r } = await open({ visible: false });
    expect(text(r)).not.toContain('Before we build your list');
  });
});
