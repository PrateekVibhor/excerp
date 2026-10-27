import { Keyboard, KeyboardAvoidingView, StyleSheet, Text, TextInput } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import type { ReactTestInstance } from 'react-test-renderer';
import { act, create } from 'react-test-renderer';
import { replySubject } from '../../data/messageDraft';
import { InMailSheet, NEW_NOTE, REPLY_NOTE, type Recipient, type SendOutcome } from './InMailSheet';

jest.mock('@react-native-async-storage/async-storage', () => require('@react-native-async-storage/async-storage/jest/async-storage-mock'));

const metrics = { frame: { x: 0, y: 0, width: 375, height: 667 }, insets: { top: 20, left: 0, right: 0, bottom: 0 } };
const maya: Recipient = { readerId: 'p-1', name: 'Maya Chen', initials: 'MC', tone: 0 };
const sent = async (): Promise<SendOutcome> => ({ ok: true });

type Props = Partial<React.ComponentProps<typeof InMailSheet>>;
function sheetWith(props: Props) {
  return (
    <SafeAreaProvider initialMetrics={metrics}>
      <InMailSheet visible mode="new" to={maya} initialSubject="" onSend={sent} onClose={() => {}} onSent={() => {}} {...props} />
    </SafeAreaProvider>
  );
}

async function open(props: Props = {}) {
  let renderer!: ReturnType<typeof create>;
  await act(async () => {
    renderer = create(sheetWith(props));
  });
  const texts = () => renderer.root.findAllByType(Text).map((t) => [t.props.children].flat().join(''));
  const field = (label: string) => renderer.root.findAll((n: ReactTestInstance) => n.type === TextInput && n.props.accessibilityLabel === label)[0];
  const button = (label: string) => renderer.root.findAll((n: ReactTestInstance) => n.props.accessibilityLabel === label && n.props.accessibilityRole === 'button')[0];
  return {
    renderer,
    texts,
    has: (t: string) => texts().includes(t),
    field,
    button,
    // Not returned from act: a press can start a send that is still pending, and act would wait for it.
    type: (label: string, value: string) => act(async () => { field(label).props.onChangeText(value); }),
    press: (label: string) => act(async () => { button(label).props.onPress(); }),
    rerender: (next: Props) => act(async () => renderer.update(sheetWith({ ...props, ...next }))),
    sendDisabled: () => button('Send').props.accessibilityState.disabled === true,
  };
}

let dismiss: jest.SpyInstance;
beforeEach(() => {
  dismiss = jest.spyOn(Keyboard, 'dismiss').mockImplementation(() => {});
});
afterEach(() => dismiss.mockRestore());

describe('InMailSheet', () => {
  it('shows nothing while closed', async () => {
    expect((await open({ visible: false })).texts()).toEqual([]);
  });

  it('Scenario: a new message is a request, and the sheet says what that means; a reply says only to keep to text', async () => {
    const request = await open({ mode: 'new' });
    expect(request.has('Message request')).toBe(true);
    expect(request.has(NEW_NOTE)).toBe(true);
    expect(NEW_NOTE).toContain('accept or decline');
    expect(NEW_NOTE).toContain('no links');
    const reply = await open({ mode: 'reply' });
    expect(reply.has('Reply')).toBe(true);
    expect(reply.has('Message request')).toBe(false);
    expect(reply.has(REPLY_NOTE)).toBe(true);
  });

  it('no longer carries the "messaging isn\'t built yet" placeholder', async () => {
    for (const mode of ['new', 'reply'] as const) expect((await open({ mode })).texts().join(' ')).not.toMatch(/placeholder|isn't built/i);
  });

  it('is addressed to the reader', async () => {
    const sheet = await open({ to: { readerId: 'p-2', name: 'Daniel Okafor', initials: 'DO', tone: 1 } });
    expect([sheet.has('To'), sheet.has('Daniel Okafor'), sheet.has('DO')]).toEqual([true, true, true]);
  });

  it('starts with the prefilled subject and an empty message', async () => {
    const sheet = await open({ mode: 'reply', initialSubject: replySubject('Coffee in SF next week?') });
    expect(sheet.field('Subject').props.value).toBe('Re: Coffee in SF next week?');
    expect(sheet.field('Message').props.value).toBe('');
  });

  it('Scenario: Send is blocked without text - empty or only spaces', async () => {
    const sheet = await open();
    expect(sheet.sendDisabled()).toBe(true);
    await sheet.type('Message', '   \n  ');
    expect(sheet.sendDisabled()).toBe(true);
    await sheet.type('Message', 'Hello');
    expect(sheet.sendDisabled()).toBe(false);
    await sheet.type('Message', '');
    expect(sheet.sendDisabled()).toBe(true);
  });

  it('does not send when Send is pressed while blocked', async () => {
    const onSend = jest.fn();
    const sheet = await open({ onSend });
    await act(async () => { sheet.button('Send').props.onPress?.(); });
    expect(onSend).not.toHaveBeenCalled();
  });

  it('Scenario: Length limits - a 121-character subject and a 2001-character message are refused with a message', async () => {
    const sheet = await open();
    await sheet.type('Message', 'Hello');
    await sheet.type('Subject', 'x'.repeat(120));
    expect(sheet.sendDisabled()).toBe(false);
    await sheet.type('Subject', 'x'.repeat(121));
    expect(sheet.has('Use 120 characters or fewer.')).toBe(true);
    expect(sheet.sendDisabled()).toBe(true);
    await sheet.type('Subject', '');
    await sheet.type('Message', 'x'.repeat(2001));
    expect(sheet.has('Use 2000 characters or fewer.')).toBe(true);
    expect(sheet.sendDisabled()).toBe(true);
  });

  it('Scenario: Text only - a link or an email address is refused before sending, with a reason', async () => {
    const sheet = await open();
    for (const text of ['see https://example.com', 'www.example.com', 'write to me@example.com', 'visit acme.io']) {
      await sheet.type('Message', text);
      expect(sheet.has("Links and email addresses aren't allowed.")).toBe(true);
      expect(sheet.sendDisabled()).toBe(true);
    }
    await sheet.type('Message', 'I use Node.js at work, version 1.2.3.');
    expect(sheet.sendDisabled()).toBe(false);
    await sheet.type('Subject', 'my site: example.com');
    expect(sheet.sendDisabled()).toBe(true);
  });

  it('sends the trimmed draft, then tells the screen', async () => {
    const onSend = jest.fn(sent);
    const onSent = jest.fn();
    const sheet = await open({ mode: 'reply', initialSubject: 'Re: Hello', onSend, onSent });
    await sheet.type('Message', '  Thanks!  ');
    await sheet.press('Send');
    expect(onSend).toHaveBeenCalledTimes(1);
    expect(onSend).toHaveBeenCalledWith({ subject: 'Re: Hello', body: 'Thanks!' });
    expect(onSent).toHaveBeenCalledTimes(1);
  });

  it('sends only once when Send is pressed twice quickly', async () => {
    let finish!: (r: SendOutcome) => void;
    const onSend = jest.fn(() => new Promise<SendOutcome>((r) => (finish = r)));
    const sheet = await open({ onSend });
    await sheet.type('Message', 'Hello');
    await sheet.press('Send');
    expect(sheet.sendDisabled()).toBe(true);
    await act(async () => { sheet.button('Send').props.onPress?.(); });
    expect(onSend).toHaveBeenCalledTimes(1);
    await act(async () => finish({ ok: true }));
  });

  it('closes the keyboard when sending', async () => {
    const sheet = await open();
    await sheet.type('Message', 'Hello');
    dismiss.mockClear();
    await sheet.press('Send');
    expect(dismiss).toHaveBeenCalled();
  });

  it('Scenario: the server says no - the reason is shown in words, nothing typed is lost, and the reader can try again', async () => {
    const onSend = jest.fn().mockResolvedValueOnce({ ok: false, message: "You've already written to this reader." }).mockResolvedValueOnce({ ok: true });
    const onSent = jest.fn();
    const sheet = await open({ onSend, onSent });
    await sheet.type('Message', 'Hello');
    await sheet.press('Send');
    expect(onSent).not.toHaveBeenCalled();
    expect(sheet.has("You've already written to this reader.")).toBe(true);
    expect(sheet.field('Message').props.value).toBe('Hello');
    expect(sheet.sendDisabled()).toBe(false);
    await sheet.press('Send');
    expect(onSent).toHaveBeenCalledTimes(1);
    expect(sheet.has("You've already written to this reader.")).toBe(false);
  });

  it('a send that throws is also a message and not a crash', async () => {
    const onSend = jest.fn().mockRejectedValueOnce(new Error('boom'));
    const sheet = await open({ onSend });
    await sheet.type('Message', 'Hello');
    await sheet.press('Send');
    expect(sheet.has("Couldn't send your message. Try again.")).toBe(true);
  });

  it('Cancel and the backdrop close the sheet without sending, and close the keyboard', async () => {
    const onSend = jest.fn();
    const onClose = jest.fn();
    const sheet = await open({ onSend, onClose });
    await sheet.type('Message', 'Hello');
    dismiss.mockClear();
    await sheet.press('Cancel');
    await sheet.press('Close');
    expect(onClose).toHaveBeenCalledTimes(2);
    expect(dismiss).toHaveBeenCalledTimes(2);
    expect(onSend).not.toHaveBeenCalled();
  });

  it('closes the keyboard when empty space on the sheet is tapped, without closing the sheet or sending', async () => {
    const onSend = jest.fn();
    const onClose = jest.fn();
    const sheet = await open({ onSend, onClose });
    await sheet.type('Message', 'Hello');
    dismiss.mockClear();
    const surface = sheet.renderer.root.findAll((n: ReactTestInstance) => n.props.accessible === false && typeof n.props.onPress === 'function')[0];
    await act(async () => { surface.props.onPress(); });
    expect(dismiss).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
    expect(onSend).not.toHaveBeenCalled();
    expect(sheet.field('Message').props.value).toBe('Hello');
  });

  it('keeps the header (Cancel, title, Send) below the status bar, so it stays reachable with the keyboard up', async () => {
    const sheet = await open();
    expect(StyleSheet.flatten(sheet.renderer.root.findByType(KeyboardAvoidingView).props.style).paddingTop).toBe(20 + 8);
  });

  describe('with the keyboard up (the Reply sheet on a phone)', () => {
    const handlers = new Map<string, Array<() => void>>();
    const emit = (name: string) => act(async () => void (handlers.get(name) ?? []).forEach((h) => h()));
    const sheetStyle = (sheet: Awaited<ReturnType<typeof open>>) => StyleSheet.flatten(sheet.renderer.root.findAll((n: ReactTestInstance) => n.props.accessible === false && typeof n.props.onPress === 'function')[0]!.props.style);
    beforeEach(() => {
      handlers.clear();
      jest.spyOn(Keyboard, 'addListener').mockImplementation(((name: string, fn: () => void) => {
        handlers.set(name, [...(handlers.get(name) ?? []), fn]);
        return { remove: () => handlers.set(name, (handlers.get(name) ?? []).filter((h) => h !== fn)) };
      }) as never);
    });
    afterEach(() => jest.restoreAllMocks());

    it('the sheet can shrink to the room between the top inset and the keyboard, so its header is never pushed under the status bar', async () => {
      // Layout is not run in jest; what is checked is what decides it. The old sheet was a fixed 560 high with a percentage maximum, which does not count the padding
      // under the status bar or above the keyboard, so with the keyboard up it overflowed upwards past the inset.
      const sheet = await open({ mode: 'reply' });
      const style = sheetStyle(sheet);
      expect(style.flexShrink).toBe(1);
      expect(style.maxHeight).toBeUndefined();
      expect(StyleSheet.flatten(sheet.renderer.root.findByType(KeyboardAvoidingView).props.style).paddingTop).toBe(20 + 8);
      expect(style.minHeight ?? 0).toBe(0);
    });

    it('gives back the home-indicator room under the sheet while the keyboard is up', async () => {
      const sheet = await open({ mode: 'reply' });
      const down = sheetStyle(sheet).paddingBottom as number;
      await emit('keyboardWillShow');
      expect(sheetStyle(sheet).paddingBottom as number).toBeLessThan(down);
      await emit('keyboardWillHide');
      expect(sheetStyle(sheet).paddingBottom).toBe(down);
    });

    it('Cancel and Send are at least 44 points to tap', async () => {
      const sheet = await open({ mode: 'reply' });
      for (const label of ['Cancel', 'Send']) {
        const style = StyleSheet.flatten(sheet.button(label).props.style);
        expect(style.minHeight).toBeGreaterThanOrEqual(44);
        expect(style.minWidth).toBeGreaterThanOrEqual(44);
      }
    });

    it('a tap on the dimmed area while the keyboard is up only hides the keyboard: the sheet stays and the text is kept', async () => {
      const onClose = jest.fn();
      const sheet = await open({ mode: 'reply', onClose });
      await sheet.type('Message', 'Half-written');
      await emit('keyboardWillShow');
      dismiss.mockClear();
      await sheet.press('Close');
      expect(dismiss).toHaveBeenCalledTimes(1);
      expect(onClose).not.toHaveBeenCalled();
      expect(sheet.field('Message').props.value).toBe('Half-written');
      // Once the keyboard is down, the next tap on the dimmed area closes the sheet, as before.
      await emit('keyboardWillHide');
      await sheet.press('Close');
      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('Cancel still closes the sheet with the keyboard up', async () => {
      const onClose = jest.fn();
      const sheet = await open({ mode: 'reply', onClose });
      await emit('keyboardWillShow');
      await sheet.press('Cancel');
      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('Send with the keyboard up sends once, even if it is pressed twice', async () => {
      let finish!: (o: SendOutcome) => void;
      const onSend = jest.fn(() => new Promise<SendOutcome>((r) => (finish = r)));
      const onSent = jest.fn();
      const sheet = await open({ mode: 'reply', initialSubject: 'Re: Hi', onSend, onSent });
      await sheet.type('Message', 'Thanks!');
      await emit('keyboardWillShow');
      await sheet.press('Send');
      await sheet.press('Send');
      expect(onSend).toHaveBeenCalledTimes(1);
      await act(async () => finish({ ok: true }));
      expect(onSent).toHaveBeenCalledTimes(1);
    });
  });

  it('starts fresh each time it opens', async () => {
    const sheet = await open({ mode: 'reply', initialSubject: 'Re: Hello' });
    await sheet.type('Subject', 'Something else');
    await sheet.type('Message', 'Half-written');
    await sheet.rerender({ visible: false });
    await sheet.rerender({ visible: true });
    expect(sheet.field('Subject').props.value).toBe('Re: Hello');
    expect(sheet.field('Message').props.value).toBe('');
  });
});
