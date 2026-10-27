// Lets the Android app use plain http:// for ONE host (the pipeline API), and nowhere else.
//
// Android 9+ blocks cleartext traffic by default, so a release build of the app could not load the
// feed from http://<api host>:8080. This adds a network security config that permits cleartext for
// that host only, the same narrow exception app.json declares for iOS (App Transport Security).
// Remove it once the API has HTTPS.
//
// Usage in app.json:  ["./plugins/withAndroidApiCleartext.js", { "host": "YOUR-API-HOST" }]
const fs = require('fs');
const path = require('path');
const { withAndroidManifest, withDangerousMod } = require('expo/config-plugins');

const CONFIG_NAME = 'network_security_config';

/** Letters, digits, dots and hyphens only: a hostname or an IPv4 address, so it is safe inside XML. */
function assertHost(host) {
  if (typeof host !== 'string' || !/^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$/.test(host)) {
    throw new Error(
      `withAndroidApiCleartext: "host" must be a hostname or IP address such as "YOUR-API-HOST", got ${JSON.stringify(host)}.`,
    );
  }
  return host;
}

function networkSecurityConfigXml(host) {
  return `<?xml version="1.0" encoding="utf-8"?>
<network-security-config>
  <domain-config cleartextTrafficPermitted="true">
    <domain includeSubdomains="false">${assertHost(host)}</domain>
  </domain-config>
</network-security-config>
`;
}

/** Points the <application> element at the config. Leaves a manifest that already names one alone. */
function setNetworkSecurityConfig(manifest) {
  const application = manifest.manifest.application?.[0];
  if (!application) throw new Error('withAndroidApiCleartext: AndroidManifest.xml has no <application> element.');
  application.$ = application.$ ?? {};
  if (!application.$['android:networkSecurityConfig']) {
    application.$['android:networkSecurityConfig'] = `@xml/${CONFIG_NAME}`;
  }
  return manifest;
}

const withAndroidApiCleartext = (config, props = {}) => {
  const host = assertHost(props.host);

  config = withDangerousMod(config, [
    'android',
    (cfg) => {
      const dir = path.join(cfg.modRequest.platformProjectRoot, 'app/src/main/res/xml');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, `${CONFIG_NAME}.xml`), networkSecurityConfigXml(host));
      return cfg;
    },
  ]);

  return withAndroidManifest(config, (cfg) => {
    cfg.modResults = setNetworkSecurityConfig(cfg.modResults);
    return cfg;
  });
};

module.exports = withAndroidApiCleartext;
module.exports.helpers = { assertHost, networkSecurityConfigXml, setNetworkSecurityConfig, CONFIG_NAME };
