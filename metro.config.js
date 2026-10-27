const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);

// The stand-in for Google's sign-in (src/features/auth/fakeGoogle) belongs to the end-to-end test build only. In every other
// build it resolves to an empty module, so none of its code, and none of its test tokens, is in the app. EXPO_PUBLIC_E2E is
// read when the app is built; after changing it, start Metro with --clear so no earlier result is reused.
const e2eBuild = process.env.EXPO_PUBLIC_E2E === 'true';
const standIn = /(^|\/)fakeGoogle$/;
const resolveRequest = config.resolver.resolveRequest;

config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (!e2eBuild && standIn.test(moduleName)) return { type: 'empty' };
  return (resolveRequest ?? context.resolveRequest)(context, moduleName, platform);
};

module.exports = config;
