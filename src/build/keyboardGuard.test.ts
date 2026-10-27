// Every screen or sheet with a text field handles the keyboard the same way, through src/components/KeyboardSafe.tsx: the keyboard never covers the field being typed in,
// and the button that continues stays reachable. This finds every file that draws a TextInput and fails if one does not use it, or does its own keyboard avoiding.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const root = join(__dirname, '../..');
function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === 'node_modules' ? [] : files(path);
    return /\.tsx$/.test(name) && !/\.test\.tsx$/.test(name) ? [path] : [];
  });
}
const withInput = [...files(join(root, 'src')), ...files(join(root, 'app'))].filter((f) => /<TextInput\b/.test(readFileSync(f, 'utf8')));
const rel = (f: string) => relative(root, f);

describe('the keyboard and text fields', () => {
  it('finds the screens that have a text field (so this guard cannot pass by finding none)', () => {
    expect(withInput.map(rel).sort()).toEqual([
      'src/features/courses/IntakeScreen.tsx',
      'src/features/courses/RenameDialog.tsx',
      'src/features/profile/InMailSheet.tsx',
      'src/features/profile/ProfileForm.tsx',
      'src/features/readers/ReportSheet.tsx',
    ]);
  });

  // ProfileForm is a form inside the Profile screen's scrolling body, which is the one that uses the wrapper.
  const owner = (f: string) => (rel(f) === 'src/features/profile/ProfileForm.tsx' ? join(root, 'src/features/profile/ProfileScreen.tsx') : f);

  it.each(withInput.map((f) => [rel(f), f] as const))('%s uses the shared keyboard-safe wrapper', (_name, file) => {
    expect(readFileSync(owner(file), 'utf8')).toMatch(/from '(\.\.\/)+components\/KeyboardSafe'/);
  });

  it('nothing else does its own keyboard avoiding, so there is one behaviour to reason about', () => {
    const own = [...files(join(root, 'src')), ...files(join(root, 'app'))].filter((f) => !/KeyboardSafe\.tsx$/.test(f) && /\bKeyboardAvoidingView\b|automaticallyAdjustKeyboardInsets/.test(readFileSync(f, 'utf8')));
    expect(own.map(rel)).toEqual([]);
  });

  it('the floating tab bar gets out of the way of the keyboard', () => {
    expect(readFileSync(join(root, 'src/components/GlassTabBar.tsx'), 'utf8')).toContain('useKeyboardVisible');
  });
});
