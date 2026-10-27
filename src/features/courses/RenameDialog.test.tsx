import { TextInput } from 'react-native';
import { act } from 'react-test-renderer';
import { byLabel, mount, press, text, unmountAll } from '../readers/testing';
import { RenameDialog } from './RenameDialog';

const open = (over: Partial<React.ComponentProps<typeof RenameDialog>> = {}) => {
  const onSave = jest.fn();
  const onCancel = jest.fn();
  return mount(<RenameDialog visible initial="Business analyst · Fintech · Oct 19" onSave={onSave} onCancel={onCancel} {...over} />).then((r) => ({ r, onSave, onCancel }));
};
const field = (r: Awaited<ReturnType<typeof open>>['r']) => r.root.findByType(TextInput);
const type = (r: Awaited<ReturnType<typeof open>>['r'], value: string) => act(async () => { field(r).props.onChangeText(value); });

afterEach(unmountAll);

describe('RenameDialog', () => {
  it('shows the current name to change, one line, no more than 80 characters', async () => {
    const { r } = await open();
    expect(text(r)).toContain('Rename list');
    expect(field(r).props.value).toBe('Business analyst · Fintech · Oct 19');
    expect(field(r).props.maxLength).toBe(80);
    expect(field(r).props.multiline).not.toBe(true);
    expect(field(r).props.accessibilityLabel).toBe('List name');
  });

  it('saves the new name, trimmed', async () => {
    const { r, onSave } = await open();
    await type(r, '  Treasury systems role  ');
    await press(r, 'Save');
    expect(onSave).toHaveBeenCalledWith('Treasury systems role');
  });

  it('an empty name clears the name: it saves nothing, and says it will go back to the default', async () => {
    const { r, onSave } = await open();
    expect(text(r)).toContain('Leave it empty to use the default name.');
    await type(r, '   ');
    await press(r, 'Save');
    expect(onSave).toHaveBeenCalledWith('');
  });

  it('shows how much of the 80 characters is used', async () => {
    const { r } = await open({ initial: '' });
    await type(r, 'x'.repeat(30));
    expect(text(r)).toContain('30/80');
  });

  it('shows why a save did not work, and cannot be pressed twice while saving', async () => {
    const { r } = await open({ error: 'Use between 1 and 80 characters, on one line.', busy: true });
    expect(r.root.findAll((n) => n.props.accessibilityRole === 'alert').length).toBeGreaterThan(0);
    expect(text(r)).toContain('between 1 and 80');
    expect(byLabel(r, 'Save')[0]!.props.accessibilityState).toMatchObject({ disabled: true });
  });

  it('Cancel leaves the name as it was', async () => {
    const { r, onSave, onCancel } = await open();
    await press(r, 'Cancel');
    expect(onCancel).toHaveBeenCalled();
    expect(onSave).not.toHaveBeenCalled();
  });

  it('opens with the current name each time, not the last thing typed', async () => {
    const { r } = await open();
    await type(r, 'something else');
    await act(async () => { r.update(<RenameDialog visible={false} initial="Business analyst · Fintech · Oct 19" onSave={jest.fn()} onCancel={jest.fn()} />); });
    await act(async () => { r.update(<RenameDialog visible initial="Business analyst · Fintech · Oct 19" onSave={jest.fn()} onCancel={jest.fn()} />); });
    expect(field(r).props.value).toBe('Business analyst · Fintech · Oct 19');
  });
});
