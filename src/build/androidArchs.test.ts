/** @jest-environment node */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Android phones need only the 64-bit ARM build of the native code. The x86 and 32-bit ARM copies made the preview APK 99 MB, of which
// 78 MB was the same native code compiled four times. This keeps the APK to the one build phones use.
const root = join(__dirname, '..', '..');
const app = JSON.parse(readFileSync(join(root, 'app.json'), 'utf8')).expo as { plugins: Array<string | [string, Record<string, any>]> };
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { dependencies: Record<string, string> };

describe('Android builds', () => {
  const entry = app.plugins.find((p) => Array.isArray(p) && p[0] === 'expo-build-properties') as [string, Record<string, any>] | undefined;

  it('use the build-properties plugin, and the package is installed', () => {
    expect(entry).toBeDefined();
    expect(pkg.dependencies['expo-build-properties']).toBeDefined();
  });

  it('build the native code for 64-bit ARM phones only', () => {
    expect(entry?.[1].android?.buildArchs).toEqual(['arm64-v8a']);
  });
});
