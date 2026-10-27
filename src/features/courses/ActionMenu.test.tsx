import { act } from 'react-test-renderer';
import { byLabel, mount, press, text, unmountAll } from '../readers/testing';
import { ActionMenu } from './ActionMenu';

afterEach(unmountAll);

describe('ActionMenu', () => {
  const items = (calls: string[]) => [
    { label: 'Rename', onPress: () => calls.push('rename') },
    { label: 'Refresh now', onPress: () => calls.push('refresh'), hint: 'Checked 5 min ago' },
    { label: 'Delete', onPress: () => calls.push('delete'), destructive: true },
  ];

  it('shows its items when visible, and nothing when not', async () => {
    const calls: string[] = [];
    const r = await mount(<ActionMenu visible title="Treasury role" items={items(calls)} onClose={jest.fn()} />);
    expect(text(r)).toContain('Treasury role');
    for (const label of ['Rename', 'Refresh now', 'Delete']) expect(byLabel(r, label)).toHaveLength(1);
    expect(text(r)).toContain('Checked 5 min ago');
    expect(text(await mount(<ActionMenu visible={false} items={items(calls)} onClose={jest.fn()} />))).not.toContain('Rename');
  });

  it('pressing an item closes the menu and then does that action', async () => {
    const calls: string[] = [];
    const onClose = jest.fn(() => calls.push('close'));
    const r = await mount(<ActionMenu visible items={items(calls)} onClose={onClose} />);
    await press(r, 'Delete');
    expect(calls).toEqual(['close', 'delete']);
  });

  it('a disabled item does nothing when pressed', async () => {
    const calls: string[] = [];
    const r = await mount(<ActionMenu visible items={[{ label: 'Refresh now', onPress: () => calls.push('refresh'), disabled: true }]} onClose={jest.fn()} />);
    expect(byLabel(r, 'Refresh now')[0]!.props.accessibilityState).toMatchObject({ disabled: true });
    await act(async () => { byLabel(r, 'Refresh now')[0]!.props.onPress(); });
    expect(calls).toEqual([]);
  });

  it('Close (the bottom item) and the backdrop close it without doing anything', async () => {
    const calls: string[] = [];
    const onClose = jest.fn();
    const r = await mount(<ActionMenu visible items={items(calls)} onClose={onClose} />);
    expect(byLabel(r, 'Cancel')).toHaveLength(0);
    await press(r, 'Close');
    await press(r, 'Close menu');
    expect(onClose).toHaveBeenCalledTimes(2);
    expect(calls).toEqual([]);
  });
});
