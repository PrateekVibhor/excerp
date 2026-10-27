// eslint-disable-next-line @typescript-eslint/no-require-imports
const plugin = require('./withAndroidApiCleartext');
const { assertHost, networkSecurityConfigXml, setNetworkSecurityConfig } = plugin.helpers;

describe('networkSecurityConfigXml', () => {
  it('allows cleartext for the one host, without subdomains', () => {
    const xml = networkSecurityConfigXml('YOUR-API-HOST');
    expect(xml).toContain('<domain includeSubdomains="false">YOUR-API-HOST</domain>');
    expect(xml).toContain('<domain-config cleartextTrafficPermitted="true">');
  });

  it('does not allow cleartext for anything else', () => {
    const xml = networkSecurityConfigXml('api.example.com');
    expect(xml.match(/cleartextTrafficPermitted="true"/g)).toHaveLength(1);
    expect(xml).not.toMatch(/base-config/);
    expect(xml.match(/<domain /g)).toHaveLength(1);
  });

  it('is well-formed XML with the declaration first', () => {
    const xml = networkSecurityConfigXml('example.com');
    expect(xml.startsWith('<?xml version="1.0" encoding="utf-8"?>')).toBe(true);
    expect(xml).toMatch(/<network-security-config>[\s\S]*<\/network-security-config>\n$/);
  });
});

describe('assertHost', () => {
  it('accepts hostnames and IP addresses', () => {
    for (const host of ['YOUR-API-HOST', 'api.example.com', 'my-host', 'a1']) expect(assertHost(host)).toBe(host);
  });

  it('rejects anything that could break out of the XML or is not a host', () => {
    for (const bad of ['', ' ', 'YOUR-API-HOST:8080', 'http://YOUR-API-HOST', 'a b', '<x>', 'a"b', '-bad', 'bad-', 'a/b', undefined, null, 42])
      expect(() => assertHost(bad)).toThrow(/"host" must be a hostname or IP/);
  });

  it('is what the plugin itself requires, so a missing host fails the build early', () => {
    expect(() => plugin({}, {})).toThrow(/"host" must be/);
    expect(() => plugin({})).toThrow(/"host" must be/);
  });
});

describe('setNetworkSecurityConfig', () => {
  const manifest = (appAttrs?: Record<string, string>) => ({ manifest: { application: [{ $: appAttrs ?? { 'android:name': '.MainApplication' } }] } });

  it('points <application> at the config and keeps its other attributes', () => {
    const result = setNetworkSecurityConfig(manifest());
    expect(result.manifest.application[0].$).toEqual({
      'android:name': '.MainApplication',
      'android:networkSecurityConfig': '@xml/network_security_config',
    });
  });

  it('leaves a manifest that already names a config alone', () => {
    const existing = manifest({ 'android:networkSecurityConfig': '@xml/custom' });
    expect(setNetworkSecurityConfig(existing).manifest.application[0].$['android:networkSecurityConfig']).toBe('@xml/custom');
  });

  it('can be applied twice with the same result', () => {
    const once = setNetworkSecurityConfig(manifest());
    const twice = setNetworkSecurityConfig(once);
    expect(twice).toEqual(once);
  });

  it('copes with an <application> that has no attributes yet', () => {
    const result = setNetworkSecurityConfig({ manifest: { application: [{}] } });
    expect(result.manifest.application[0].$['android:networkSecurityConfig']).toBe('@xml/network_security_config');
  });

  it('stops with a clear message if there is no <application> element', () => {
    expect(() => setNetworkSecurityConfig({ manifest: {} })).toThrow(/no <application> element/);
  });
});
