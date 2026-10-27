import { isOpenableUrl, openOriginal } from './openOriginal';

afterEach(() => jest.restoreAllMocks());

describe('isOpenableUrl', () => {
  it('accepts http and https addresses', () => {
    expect(isOpenableUrl('https://research.nvidia.com/')).toBe(true);
    expect(isOpenableUrl('http://example.com/a?b=c')).toBe(true);
    expect(isOpenableUrl('HTTPS://Example.com')).toBe(true);
  });

  it('refuses anything that is not a web address', () => {
    for (const bad of ['javascript:alert(1)', 'file:///etc/passwd', 'tel:123', 'intent://x', '//example.com', 'example.com', '', 'https://', 'https://exa mple.com']) {
      expect(isOpenableUrl(bad)).toBe(false);
    }
  });
});

describe('openOriginal', () => {
  it('opens the address in the in-app browser', async () => {
    const browser = { openBrowserAsync: jest.fn().mockResolvedValue({ type: 'dismiss' }) };
    await expect(openOriginal('https://www.anthropic.com/research', browser)).resolves.toBe(true);
    expect(browser.openBrowserAsync).toHaveBeenCalledTimes(1);
    expect(browser.openBrowserAsync).toHaveBeenCalledWith('https://www.anthropic.com/research');
  });

  it('does not open a link that is not a web address', async () => {
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    const browser = { openBrowserAsync: jest.fn() };
    await expect(openOriginal('javascript:alert(1)', browser)).resolves.toBe(false);
    expect(browser.openBrowserAsync).not.toHaveBeenCalled();
  });

  it('does not throw when the browser fails to open', async () => {
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    const browser = { openBrowserAsync: jest.fn().mockRejectedValue(new Error('no browser available')) };
    await expect(openOriginal('https://openai.com/news/', browser)).resolves.toBe(false);
  });
});
