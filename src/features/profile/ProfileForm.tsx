import { useState } from 'react';
import { Keyboard, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import Svg, { Path } from 'react-native-svg';
import { INDUSTRIES, INTERESTS, type Profile } from '../../data/types';
import { colors, profile as layout, typography } from '../../theme';
import { ChipPicker } from './ChipPicker';
import { CUSTOM_TOPIC_MAX, INTERESTS_MAX, normalizeTopic, OTHER_TOPIC, toggleInterest, validateProfile } from './validation';

const DEFAULT_INDUSTRY = 'Other';

const isPreset = (topic: string) => (INTERESTS as readonly string[]).includes(topic);

/**
 * The profile form: name, industry and topics. Save stays disabled until the draft passes
 * `validateProfile`. The "Other" chip opens a field for one topic of the reader's own; it holds a place
 * among the topics (at most INTERESTS_MAX), and what is typed is saved as a topic like the presets.
 */
export function ProfileForm({
  initial,
  onSave,
}: {
  initial?: Profile;
  onSave: (profile: Profile) => void | Promise<void>;
}) {
  const [name, setName] = useState(initial?.display_name ?? '');
  const [industry, setIndustry] = useState<string>(initial?.industry ?? DEFAULT_INDUSTRY);
  // The chips that are on ("Other" included) and the text typed for "Other". A saved topic that is not
  // a preset is the reader's own, so editing a saved profile brings it back under "Other".
  const savedCustom = initial?.interests.find((topic) => !isPreset(topic));
  const [selected, setSelected] = useState<string[]>(() => [
    ...(initial?.interests ?? []).filter(isPreset),
    ...(savedCustom === undefined ? [] : [OTHER_TOPIC]),
  ]);
  const [otherText, setOtherText] = useState(savedCustom ?? '');
  const [refused, setRefused] = useState(false);
  const [focusOther, setFocusOther] = useState(false);
  const interests = selected.map((chip) => (chip === OTHER_TOPIC ? otherText : chip));
  const [menuOpen, setMenuOpen] = useState(false);
  const [focused, setFocused] = useState(false);

  const check = validateProfile({ display_name: name, industry, interests });
  // An empty name just keeps Save off; a message is only for a name that is too long.
  const nameError = !check.ok && name.trim() !== '' ? check.errors.display_name : undefined;

  const otherOn = selected.includes(OTHER_TOPIC);
  const customTopic = normalizeTopic(otherText);
  // A message under the field for what was typed (a repeat, "Other" itself); a blank field just keeps Save off.
  const otherError = otherOn && customTopic !== '' && !check.ok ? check.errors.interests : undefined;

  const toggle = (chip: string) => {
    Keyboard.dismiss();
    const result = toggleInterest(selected, chip);
    setSelected(result.interests);
    setRefused(result.refused);
    // Opening "Other" takes the reader straight to the field.
    setFocusOther(chip === OTHER_TOPIC && result.interests.includes(OTHER_TOPIC));
  };

  return (
    <View style={styles.form}>
      <View style={styles.field}>
        <Text style={[typography.formLabel, { color: colors.form.label }]}>Name</Text>
        <TextInput
          accessibilityLabel="Name"
          value={name}
          onChangeText={setName}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          placeholder="Jordan Lee"
          placeholderTextColor={colors.form.placeholder}
          autoCapitalize="words"
          autoCorrect={false}
          selectionColor={colors.accent.default}
          style={[
            styles.input,
            typography.formInput,
            { color: colors.text.primary },
            focused && { borderColor: colors.form.inputBorderFocus },
            nameError !== undefined && { borderColor: colors.form.error },
          ]}
        />
        {nameError !== undefined && (
          <Text accessibilityRole="alert" style={[typography.formHint, { color: colors.form.error }]}>
            {nameError}
          </Text>
        )}
        <Text style={[typography.formHint, { color: colors.form.hint }]}>Shown to other readers on the leaderboard once you verify an article.</Text>
      </View>

      <View style={styles.field}>
        <Text style={[typography.formLabel, { color: colors.form.label }]}>Industry you work in</Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Industry, ${industry}`}
          accessibilityState={{ expanded: menuOpen }}
          onPress={() => {
            Keyboard.dismiss();
            setMenuOpen((open) => !open);
          }}
          style={[styles.input, styles.select, menuOpen && { borderColor: colors.form.inputBorderFocus }]}
        >
          <Text style={[typography.formInput, { color: colors.text.primary }]}>{industry}</Text>
          <Svg
            width={layout.chevronWidth}
            height={layout.chevronHeight}
            viewBox="0 0 12 8"
            fill="none"
            style={{ transform: [{ rotate: menuOpen ? '180deg' : '0deg' }] }}
          >
            <Path d="M1 1.5l5 5 5-5" stroke={colors.text.tertiary} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
          </Svg>
        </Pressable>
        {menuOpen && (
          <View style={styles.menu}>
            {INDUSTRIES.map((option, i) => {
              const on = option === industry;
              return (
                <Pressable
                  key={option}
                  accessibilityRole="radio"
                  accessibilityState={{ selected: on }}
                  accessibilityLabel={option}
                  onPress={() => {
                    Keyboard.dismiss();
                    setIndustry(option);
                    setMenuOpen(false);
                  }}
                  style={[styles.option, i > 0 && styles.optionDivider]}
                >
                  <Text style={[typography.formOption, { color: on ? colors.text.primary : colors.text.secondary }]}>
                    {option}
                  </Text>
                  {on && (
                    <Svg width={layout.checkSize} height={layout.checkSize} viewBox="0 0 24 24" fill="none">
                      <Path d="M20 6 9 17l-5-5" stroke={colors.form.check} strokeWidth={2.6} strokeLinecap="round" strokeLinejoin="round" />
                    </Svg>
                  )}
                </Pressable>
              );
            })}
          </View>
        )}
      </View>

      <View style={styles.field}>
        <Text style={[typography.formLabel, { color: colors.form.label }]}>Topics you follow</Text>
        <Text style={[typography.formHint, { color: colors.form.hint }]}>Used for personalization later.</Text>
        <View style={styles.chips}>
          <ChipPicker options={[...INTERESTS, OTHER_TOPIC]} selected={selected} onToggle={toggle} />
        </View>
        {otherOn && (
          <View style={styles.field}>
            <TextInput
              accessibilityLabel="Your topic"
              value={otherText}
              onChangeText={setOtherText}
              placeholder="Type your topic"
              placeholderTextColor={colors.form.placeholder}
              autoFocus={focusOther}
              autoCorrect={false}
              maxLength={CUSTOM_TOPIC_MAX}
              selectionColor={colors.accent.default}
              style={[
                styles.input,
                typography.formInput,
                { color: colors.text.primary },
                otherError !== undefined && { borderColor: colors.form.error },
              ]}
            />
            {otherError !== undefined ? (
              <Text accessibilityRole="alert" style={[typography.formHint, { color: colors.form.error }]}>
                {otherError}
              </Text>
            ) : (
              customTopic !== '' && (
                <Text style={[typography.formHint, { color: colors.form.hint }]}>{`Saved as "${customTopic}"`}</Text>
              )
            )}
          </View>
        )}
        <Text
          accessibilityLiveRegion="polite"
          style={[typography.formCount, { color: refused ? colors.form.error : colors.form.hint }]}
        >
          {refused ? `You can pick up to ${INTERESTS_MAX} topics.` : `${selected.length} of ${INTERESTS_MAX} selected`}
        </Text>
      </View>

      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Save profile"
        accessibilityState={{ disabled: !check.ok }}
        disabled={!check.ok}
        onPress={() => {
          Keyboard.dismiss();
          if (check.ok) onSave(check.profile);
        }}
        style={[styles.save, !check.ok && { backgroundColor: colors.form.saveDisabledBg }]}
      >
        <Text
          style={[
            typography.formSave,
            { color: check.ok ? colors.statePanel.primaryText : colors.form.saveDisabledText },
          ]}
        >
          Save profile
        </Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  form: { gap: layout.sectionGap },
  field: { gap: layout.fieldGap },
  input: {
    height: layout.inputHeight,
    borderRadius: layout.inputRadius,
    paddingHorizontal: layout.inputPaddingH,
    backgroundColor: colors.form.inputBg,
    borderWidth: 1,
    borderColor: colors.form.inputBorder,
  },
  select: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  menu: {
    borderRadius: layout.menuRadius,
    backgroundColor: colors.form.menuBg,
    borderWidth: 1,
    borderColor: colors.form.inputBorder,
    overflow: 'hidden',
  },
  option: {
    height: layout.optionHeight,
    paddingHorizontal: layout.inputPaddingH,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  optionDivider: { borderTopWidth: 1, borderTopColor: colors.form.menuDivider },
  chips: { marginTop: layout.hintGap },
  save: {
    height: layout.saveHeight,
    borderRadius: 999,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.statePanel.primaryBg,
  },
});
