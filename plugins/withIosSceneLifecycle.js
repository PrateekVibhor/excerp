// Adopts the UIScene lifecycle in the generated iOS project.
//
// iOS 27 (Xcode 27) traps at launch, in UIKitCore's "no scene lifecycle adoption" check, for apps that
// still use the single-window UIApplicationDelegate setup. Expo SDK 57 ships `ExpoAppSceneDelegate` but
// its native template does not use it yet; the SDK 58 template does. This plugin applies the same four
// changes to an SDK 57 project each time `ios/` is generated:
//   1. add SceneDelegate.swift (a subclass of ExpoAppSceneDelegate),
//   2. add the scene manifest to Info.plist,
//   3. make AppDelegate provide the React Native factory and leave window creation to the scene,
//   4. register SceneDelegate.swift in the Xcode project.
// Each step does nothing if its result is already there, so it can run again, and it all becomes a no-op
// once the template adopts scenes itself. Remove this plugin when upgrading to SDK 58.
const fs = require('fs');
const path = require('path');
const { IOSConfig, withDangerousMod, withInfoPlist, withXcodeProject } = require('expo/config-plugins');

const FILES = path.join(__dirname, 'ios-scene-lifecycle');
const SCENE_DELEGATE_CLASS = '$(PRODUCT_MODULE_NAME).SceneDelegate';

const SCENE_MANIFEST = {
  UIApplicationSupportsMultipleScenes: false,
  UISceneConfigurations: {
    UIWindowSceneSessionRoleApplication: [
      { UISceneConfigurationName: 'Default Configuration', UISceneDelegateClassName: SCENE_DELEGATE_CLASS },
    ],
  },
};

/** 'adopted' if AppDelegate already provides the factory to a scene; 'classic' for the SDK 57 template; else 'unknown'. */
function classifyAppDelegate(source) {
  if (source.includes('ExpoReactNativeFactoryProvider')) return 'adopted';
  const isClassic =
    /class AppDelegate: ExpoAppDelegate \{/.test(source) &&
    source.includes('window = UIWindow(frame: UIScreen.main.bounds)') &&
    source.includes('factory.startReactNative(');
  return isClassic ? 'classic' : 'unknown';
}

/** The AppDelegate source to write: the SDK 58 one for a classic file, the same file if already adopted. */
function patchAppDelegate(source) {
  const kind = classifyAppDelegate(source);
  if (kind === 'adopted') return source;
  if (kind === 'unknown') {
    throw new Error(
      'withIosSceneLifecycle: AppDelegate.swift is not the Expo SDK 57 template, so it was left alone. ' +
        'iOS 27 needs the scene lifecycle: make AppDelegate conform to ExpoReactNativeFactoryProvider, remove the ' +
        'window creation, and add a SceneDelegate (see plugins/ios-scene-lifecycle), or remove this plugin.',
    );
  }
  return fs.readFileSync(path.join(FILES, 'AppDelegate.swift'), 'utf8');
}

/** Adds the scene manifest to an Info.plist object, unless it already has one. */
function addSceneManifest(plist) {
  if (plist.UIApplicationSceneManifest) return plist;
  return { ...plist, UIApplicationSceneManifest: SCENE_MANIFEST };
}

const withIosSceneLifecycle = (config) => {
  config = withDangerousMod(config, [
    'ios',
    (cfg) => {
      const dir = path.join(cfg.modRequest.platformProjectRoot, cfg.modRequest.projectName);
      const sceneDelegate = path.join(dir, 'SceneDelegate.swift');
      if (!fs.existsSync(sceneDelegate)) fs.copyFileSync(path.join(FILES, 'SceneDelegate.swift'), sceneDelegate);
      const appDelegate = path.join(dir, 'AppDelegate.swift');
      const source = fs.readFileSync(appDelegate, 'utf8');
      const patched = patchAppDelegate(source);
      if (patched !== source) fs.writeFileSync(appDelegate, patched);
      return cfg;
    },
  ]);

  config = withInfoPlist(config, (cfg) => {
    cfg.modResults = addSceneManifest(cfg.modResults);
    return cfg;
  });

  config = withXcodeProject(config, (cfg) => {
    const name = cfg.modRequest.projectName;
    const file = path.join(name, 'SceneDelegate.swift');
    if (!cfg.modResults.hasFile(file)) {
      IOSConfig.XcodeUtils.addBuildSourceFileToGroup({
        filepath: file,
        groupName: name,
        project: cfg.modResults,
      });
    }
    return cfg;
  });

  return config;
};

module.exports = withIosSceneLifecycle;
module.exports.helpers = { classifyAppDelegate, patchAppDelegate, addSceneManifest, SCENE_MANIFEST };
