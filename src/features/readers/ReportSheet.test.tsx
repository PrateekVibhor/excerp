import { KeyboardAvoidingView, ScrollView, StyleSheet, TextInput } from 'react-native';
import { act, create } from 'react-test-renderer';
import { ReportSheet } from './ReportSheet';

describe('ReportSheet and the keyboard', () => {
  it('lifts the sheet above the keyboard and lets its reasons-and-note body shrink and scroll, so the note field and the Send report button both stay reachable', async () => {
    let r!: ReturnType<typeof create>;
    await act(async () => {
      r = create(<ReportSheet visible title="Report this reader" onClose={jest.fn()} onSubmit={jest.fn(async () => undefined)} />);
    });
    expect(r.root.findAllByType(KeyboardAvoidingView)).toHaveLength(1);
    const body = r.root.findByType(ScrollView);
    expect(body.findAllByType(TextInput)).toHaveLength(1); // the note
    expect(StyleSheet.flatten(body.props.style).flexShrink).toBe(1);
    expect(body.props.keyboardDismissMode).toBe('on-drag');
    expect(body.props.keyboardShouldPersistTaps).toBe('handled');
    const send = r.root.findAll((n) => n.props.accessibilityLabel === 'Send report' && typeof n.props.onPress === 'function');
    expect(send.length).toBeGreaterThan(0);
    expect(body.findAll((n) => n.props.accessibilityLabel === 'Send report')).toHaveLength(0); // the button sits under the body, outside its scrolling
  });
});
