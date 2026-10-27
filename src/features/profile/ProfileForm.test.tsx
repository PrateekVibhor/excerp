import Svg from 'react-native-svg';
import { Keyboard, TextInput } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import type { ReactTestInstance } from 'react-test-renderer';
import { act, create } from 'react-test-renderer';
import { INDUSTRIES, INTERESTS, type Profile } from '../../data/types';
import { ProfileForm } from './ProfileForm';
import { colors } from '../../theme';
import { CUSTOM_TOPIC_MAX } from './validation';

const metrics = {
  frame: { x: 0, y: 0, width: 375, height: 667 },
  insets: { top: 20, left: 0, right: 0, bottom: 0 },
};

function mount(ui: React.ReactElement) {
  let renderer!: ReturnType<typeof create>;
  act(() => {
    renderer = create(<SafeAreaProvider initialMetrics={metrics}>{ui}</SafeAreaProvider>);
  });
  const pressable = (label: string) => {
    const found = renderer.root.findAll(
      (n: ReactTestInstance) => n.props.accessibilityLabel === label && typeof n.props.onPress === 'function',
    );
    if (found.length === 0) throw new Error(`Nothing to press labelled "${label}"`);
    return found[0];
  };
  const press = (label: string) => act(() => pressable(label).props.onPress());
  const type = (text: string) =>
    act(() => {
      renderer.root.findByProps({ accessibilityLabel: 'Name', placeholder: 'Jordan Lee' }).props.onChangeText(text);
    });
  const text = () => JSON.stringify(renderer.toJSON());
  const save = () => pressable('Save profile');
  const field = (label: string) =>
    renderer.root.findAll((n: ReactTestInstance) => n.type === TextInput && n.props.accessibilityLabel === label)[0];
  const typeInto = (label: string, value: string) =>
    act(() => {
      field(label).props.onChangeText(value);
    });
  return { renderer, press, type, text, save, pressable, field, typeInto };
}

describe('ProfileForm', () => {
  it('starts empty: industry is Other, nothing selected, Save is disabled', () => {
    const { text, save, pressable } = mount(<ProfileForm onSave={jest.fn()} />);
    expect(pressable('Industry, Other')).toBeTruthy(); // the industry dropdown shows Other
    expect(text()).toContain('0 of 8 selected');
    expect(save().props.disabled).toBe(true);
  });

  it('Scenario: Save is blocked without required fields', () => {
    const { type, press, save } = mount(<ProfileForm onSave={jest.fn()} />);
    expect(save().props.disabled).toBe(true);
    type('Maya');
    expect(save().props.disabled).toBe(true); // a name but no topic
    press('Agents');
    expect(save().props.disabled).toBe(false);
    type('   ');
    expect(save().props.disabled).toBe(true); // blank name again
  });

  it('Scenario: Name length - 41 characters show a message and block Save', () => {
    const { type, press, text, save } = mount(<ProfileForm onSave={jest.fn()} />);
    press('Agents');
    type('x'.repeat(40));
    expect(text()).not.toContain('40 characters or fewer');
    expect(save().props.disabled).toBe(false);
    type('x'.repeat(41));
    expect(text()).toContain('Use 40 characters or fewer.');
    expect(save().props.disabled).toBe(true);
  });

  it('shows no name message for an empty name', () => {
    const { text } = mount(<ProfileForm onSave={jest.fn()} />);
    expect(text()).not.toContain('Enter a name');
  });

  it('Scenario: Interest limit - all 8 presets can be picked, and the count follows', () => {
    const { press, text, renderer } = mount(<ProfileForm onSave={jest.fn()} />);
    const checked = () =>
      renderer.root.findAll(
        (n) => n.props.accessibilityRole === 'checkbox' && n.props.accessibilityState?.checked && typeof n.props.onPress === 'function',
      );
    for (const interest of INTERESTS) press(interest);
    expect(text()).toContain('8 of 8 selected');
    expect(checked()).toHaveLength(8);
    press(INTERESTS[0]); // tapping a chosen topic removes it
    expect(text()).toContain('7 of 8 selected');
    expect(checked()).toHaveLength(7);
  });

  it('lets the user pick an industry from the list and closes the menu', () => {
    const { press, text, pressable } = mount(<ProfileForm onSave={jest.fn()} />);
    expect(() => pressable('Finance')).toThrow(); // menu closed
    press('Industry, Other');
    for (const industry of INDUSTRIES) expect(() => pressable(industry)).not.toThrow();
    press('Finance');
    expect(text()).toContain('"Finance"');
    expect(() => pressable('Healthcare')).toThrow(); // menu closed again
  });

  it('marks the chosen industry with a check and no other', () => {
    const { press, renderer } = mount(<ProfileForm initial={{ display_name: 'M', industry: 'Media', interests: ['Cloud'] }} onSave={jest.fn()} />);
    press('Industry, Media');
    const rows = renderer.root.findAll((n) => n.props.accessibilityRole === 'radio' && typeof n.props.onPress === 'function');
    expect(rows).toHaveLength(INDUSTRIES.length);
    const withCheck = rows.filter((row) => row.findAllByType(Svg).length > 0);
    expect(withCheck.map((row) => row.props.accessibilityLabel)).toEqual(['Media']);
  });

  it('saves the trimmed values it shows', () => {
    const onSave = jest.fn();
    const { type, press } = mount(<ProfileForm onSave={onSave} />);
    type('  Maya Chen ');
    press('Industry, Other');
    press('Software');
    press('Agents');
    press('Cloud');
    press('Save profile');
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave).toHaveBeenCalledWith({
      display_name: 'Maya Chen',
      industry: 'Software',
      interests: ['Agents', 'Cloud'],
    });
  });

  it('does not save while the draft is invalid', () => {
    const onSave = jest.fn();
    const { press, pressable } = mount(<ProfileForm onSave={onSave} />);
    press('Agents'); // no name
    act(() => pressable('Save profile').props.onPress?.());
    expect(onSave).not.toHaveBeenCalled();
  });

  it('starts from a saved profile when given one', () => {
    const initial: Profile = { display_name: 'Maya', industry: 'Media', interests: ['Safety'] };
    const onSave = jest.fn();
    const { press, text, save } = mount(<ProfileForm initial={initial} onSave={onSave} />);
    expect(text()).toContain('"Media"');
    expect(text()).toContain('1 of 8 selected');
    expect(save().props.disabled).toBe(false);
    press('Save profile');
    expect(onSave).toHaveBeenCalledWith(initial);
  });
});

describe('ProfileForm: keyboard', () => {
  let dismiss: jest.SpyInstance;
  beforeEach(() => {
    dismiss = jest.spyOn(Keyboard, 'dismiss').mockImplementation(() => {});
  });
  afterEach(() => dismiss.mockRestore());

  it('is dismissed when the industry dropdown opens, and when an industry is picked', () => {
    const { press } = mount(<ProfileForm onSave={jest.fn()} />);
    press('Industry, Other');
    expect(dismiss).toHaveBeenCalledTimes(1);
    press('Finance');
    expect(dismiss).toHaveBeenCalledTimes(2);
  });

  it('is dismissed when a topic chip is tapped', () => {
    const { press } = mount(<ProfileForm onSave={jest.fn()} />);
    press('Agents');
    expect(dismiss).toHaveBeenCalledTimes(1);
  });

  it('is dismissed when Save is pressed', () => {
    const { type, press } = mount(<ProfileForm onSave={jest.fn()} />);
    type('Maya');
    press('Agents');
    dismiss.mockClear();
    press('Save profile');
    expect(dismiss).toHaveBeenCalledTimes(1);
  });

  it('is left alone while typing in the name field', () => {
    const { type } = mount(<ProfileForm onSave={jest.fn()} />);
    type('Maya');
    expect(dismiss).not.toHaveBeenCalled();
  });
});

describe('ProfileForm: Other topic', () => {
  const CUSTOM = 'Your topic';
  const checkedLabels = (renderer: ReturnType<typeof create>) =>
    [
      ...new Set(
        renderer.root
          .findAll((n: ReactTestInstance) => n.props.accessibilityRole === 'checkbox' && n.props.accessibilityState?.checked && typeof n.props.onPress === 'function')
          .map((n) => n.props.accessibilityLabel as string),
      ),
    ];

  it('offers "Other" after the presets, as a chip like the rest', () => {
    const { pressable, text } = mount(<ProfileForm onSave={jest.fn()} />);
    expect(pressable('Other').props.accessibilityRole).toBe('checkbox');
    // The industry dropdown also says "Other", earlier on the page, so look at the chip's last appearance.
    const positions = [...INTERESTS.map((t) => text().indexOf(`"${t}"`)), text().lastIndexOf('"Other"')];
    expect(positions.every((i) => i >= 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((a, b) => a - b)); // each appears after the one before
  });

  it('shows a field to type in only while "Other" is on', () => {
    const { press, field } = mount(<ProfileForm onSave={jest.fn()} />);
    expect(field(CUSTOM)).toBeUndefined();
    press('Other');
    expect(field(CUSTOM)).toBeDefined();
    expect(field(CUSTOM).props.placeholder).toBe('Type your topic');
    press('Other');
    expect(field(CUSTOM)).toBeUndefined();
  });

  it('takes the reader to the field when "Other" is turned on', () => {
    const { press, field } = mount(<ProfileForm onSave={jest.fn()} />);
    press('Other');
    expect(field(CUSTOM).props.autoFocus).toBe(true);
  });

  it('limits what can be typed to 30 characters', () => {
    const { press, field } = mount(<ProfileForm onSave={jest.fn()} />);
    press('Other');
    expect(field(CUSTOM).props.maxLength).toBe(CUSTOM_TOPIC_MAX);
  });

  it('keeps Save off while "Other" is on but nothing is typed, even with a name and presets', () => {
    const { type, press, typeInto, save } = mount(<ProfileForm onSave={jest.fn()} />);
    type('Maya');
    press('Agents');
    expect(save().props.disabled).toBe(false);
    press('Other');
    expect(save().props.disabled).toBe(true);
    typeInto(CUSTOM, '   ');
    expect(save().props.disabled).toBe(true);
    typeInto(CUSTOM, 'finance');
    expect(save().props.disabled).toBe(false);
  });

  it('stays quiet while the field is blank: no error message, no red border, just a disabled Save', () => {
    const { press, text, field, typeInto } = mount(<ProfileForm onSave={jest.fn()} />);
    press('Other');
    expect(text()).not.toContain('Type your topic.');
    expect(text()).not.toContain('already selected');
    expect(JSON.stringify(field(CUSTOM).props.style)).not.toContain(colors.form.error);
    typeInto(CUSTOM, '   ');
    expect(text()).not.toContain('Type your topic.');
    expect(JSON.stringify(field(CUSTOM).props.style)).not.toContain(colors.form.error);
  });

  it('Scenario: Custom topic - "FINANCE" and "finance" are both saved as "Finance", in the same list as the presets', () => {
    for (const typed of ['FINANCE', 'finance']) {
      const onSave = jest.fn();
      const { type, press, typeInto } = mount(<ProfileForm onSave={onSave} />);
      type('Maya');
      press('Agents');
      press('Other');
      typeInto(CUSTOM, typed);
      press('Save profile');
      expect(onSave).toHaveBeenCalledWith({ display_name: 'Maya', industry: 'Other', interests: ['Agents', 'Finance'] });
    }
  });

  it('can be the only topic, and saves the typed text, never the word "Other"', () => {
    const onSave = jest.fn();
    const { type, press, typeInto } = mount(<ProfileForm onSave={onSave} />);
    type('Maya');
    press('Other');
    typeInto(CUSTOM, 'Robotics');
    press('Save profile');
    expect(onSave.mock.calls[0][0].interests).toEqual(['Robotics']);
  });

  it('shows how the typed topic will be saved, as it is typed', () => {
    const { press, typeInto, text } = mount(<ProfileForm onSave={jest.fn()} />);
    press('Other');
    expect(text()).not.toContain('Saved as');
    typeInto(CUSTOM, 'MACHINE learning');
    expect(text()).toContain('Saved as \\"Machine learning\\"');
  });

  it('does not save the typed text if "Other" is turned off again', () => {
    const onSave = jest.fn();
    const { type, press, typeInto } = mount(<ProfileForm onSave={onSave} />);
    type('Maya');
    press('Agents');
    press('Other');
    typeInto(CUSTOM, 'finance');
    press('Other');
    press('Save profile');
    expect(onSave.mock.calls[0][0].interests).toEqual(['Agents']);
  });

  it('files a topic that matches a preset under the preset, rather than as a second copy', () => {
    const onSave = jest.fn();
    const { type, press, typeInto } = mount(<ProfileForm onSave={onSave} />);
    type('Maya');
    press('Other');
    typeInto(CUSTOM, 'generative ai');
    press('Save profile');
    expect(onSave.mock.calls[0][0].interests).toEqual(['Generative AI']);
  });

  it('says so, and keeps Save off, when the typed topic repeats a chosen preset', () => {
    const { type, press, typeInto, text, save } = mount(<ProfileForm onSave={jest.fn()} />);
    type('Maya');
    press('Agents');
    press('Other');
    typeInto(CUSTOM, 'AGENTS');
    expect(text()).toContain('That topic is already selected.');
    expect(save().props.disabled).toBe(true);
    typeInto(CUSTOM, 'Finance');
    expect(text()).not.toContain('already selected');
    expect(save().props.disabled).toBe(false);
  });

  it('will not take the word "Other" as the topic', () => {
    const { type, press, typeInto, text, save } = mount(<ProfileForm onSave={jest.fn()} />);
    type('Maya');
    press('Other');
    typeInto(CUSTOM, 'other');
    expect(text()).toContain('Type a specific topic');
    expect(save().props.disabled).toBe(true);
  });

  it('Scenario: Interest limit - "Other" holds a place, so a ninth chip is refused with a message', () => {
    const { press, text, renderer } = mount(<ProfileForm onSave={jest.fn()} />);
    for (const interest of INTERESTS) press(interest); // 8 presets
    press('Other');
    expect(text()).toContain('You can pick up to 8 topics.');
    expect(checkedLabels(renderer)).not.toContain('Other');
    expect(checkedLabels(renderer)).toHaveLength(8);
  });

  it('counts "Other" towards the 8, and refuses a preset when it has taken the last place', () => {
    const { press, text, renderer } = mount(<ProfileForm onSave={jest.fn()} />);
    for (const interest of INTERESTS.slice(0, 7)) press(interest);
    press('Other');
    expect(text()).toContain('8 of 8 selected');
    press(INTERESTS[7]);
    expect(text()).toContain('You can pick up to 8 topics.');
    expect(checkedLabels(renderer)).not.toContain(INTERESTS[7]);
    press(INTERESTS[0]); // taking one away makes room, and the message clears
    expect(text()).toContain('7 of 8 selected');
    expect(text()).not.toContain('You can pick up to');
  });

  it('starts from a saved profile with a topic of the reader\'s own: "Other" is on and holds that text', () => {
    const initial: Profile = { display_name: 'Maya', industry: 'Media', interests: ['Agents', 'Finance'] };
    const onSave = jest.fn();
    const { renderer, field, press } = mount(<ProfileForm initial={initial} onSave={onSave} />);
    expect(checkedLabels(renderer).sort()).toEqual(['Agents', 'Other']);
    expect(field(CUSTOM).props.value).toBe('Finance');
    expect(field(CUSTOM).props.autoFocus).toBe(false); // no keyboard pops up just because the form opened
    press('Save profile');
    expect(onSave).toHaveBeenCalledWith(initial);
  });

  it('shows no field for a saved profile that only has presets', () => {
    const { field, renderer } = mount(<ProfileForm initial={{ display_name: 'M', industry: 'Media', interests: ['Cloud'] }} onSave={jest.fn()} />);
    expect(field(CUSTOM)).toBeUndefined();
    expect(checkedLabels(renderer)).toEqual(['Cloud']);
  });

  it('lets a saved custom topic be changed', () => {
    const onSave = jest.fn();
    const { typeInto, press } = mount(<ProfileForm initial={{ display_name: 'M', industry: 'Media', interests: ['Finance'] }} onSave={onSave} />);
    typeInto(CUSTOM, 'HEALTHCARE');
    press('Save profile');
    expect(onSave.mock.calls[0][0].interests).toEqual(['Healthcare']);
  });

  it('closes the keyboard when "Other" is tapped, like the other chips', () => {
    const dismiss = jest.spyOn(Keyboard, 'dismiss').mockImplementation(() => {});
    const { press } = mount(<ProfileForm onSave={jest.fn()} />);
    press('Other');
    expect(dismiss).toHaveBeenCalledTimes(1);
    dismiss.mockRestore();
  });
});

describe('ProfileForm: the name is public on the leaderboard', () => {
  const HINT = 'Shown to other readers on the leaderboard once you verify an article.';

  it('Scenario: the Name field says where the name will be shown', () => {
    const { text } = mount(<ProfileForm onSave={jest.fn()} />);
    expect(text()).toContain(HINT);
  });

  it('says it when editing a saved profile too, and the hint is under the Name field before Industry', () => {
    const { text } = mount(<ProfileForm initial={{ display_name: 'Maya Chen', industry: 'Software', interests: ['Cloud'] }} onSave={jest.fn()} />);
    expect(text()).toContain(HINT);
    expect(text().indexOf(HINT)).toBeLessThan(text().indexOf('Industry you work in'));
    expect(text().indexOf(HINT)).toBeGreaterThan(text().indexOf('"Name"'));
  });

  it('stays in view next to a name error, and the error is still shown', async () => {
    const { text, type } = mount(<ProfileForm onSave={jest.fn()} />);
    await type('x'.repeat(41));
    expect(text()).toContain(HINT);
    expect(text()).toContain('Use 40 characters or fewer.');
  });
});

