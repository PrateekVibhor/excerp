import * as WebBrowser from 'expo-web-browser';

/** Only web addresses are opened; anything else (a stray `javascript:` link, say) is refused. */
export function isOpenableUrl(url: string): boolean {
  return /^https?:\/\/[^\s]+$/i.test(url);
}

/**
 * Opens an article's source page in the in-app browser. Resolves true if the browser
 * was shown, false if it was refused or failed; it never throws, so a failure
 * cannot crash the screen. With no network the browser shows its own error page.
 */
export async function openOriginal(url: string, browser: Pick<typeof WebBrowser, 'openBrowserAsync'> = WebBrowser) {
  if (!isOpenableUrl(url)) {
    console.warn('Not opening a link that is not a web address', url);
    return false;
  }
  try {
    await browser.openBrowserAsync(url);
    return true;
  } catch (error) {
    console.warn('Could not open the original article', error);
    return false;
  }
}
