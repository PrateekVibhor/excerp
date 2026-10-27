import { colors } from './colors';

// The light mint theme must stay readable: text meets the WCAG contrast ratios on the pale background and on the glass cards.

type Rgba = [number, number, number, number];
function parse(color: string): Rgba {
  const hex = /^#([0-9a-f]{6})$/i.exec(color);
  if (hex) return [parseInt(hex[1].slice(0, 2), 16), parseInt(hex[1].slice(2, 4), 16), parseInt(hex[1].slice(4, 6), 16), 1];
  const m = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+)\s*)?\)$/.exec(color);
  if (!m) throw new Error(`cannot read the color ${color}`);
  return [Number(m[1]), Number(m[2]), Number(m[3]), m[4] === undefined ? 1 : Number(m[4])];
}
/** What the eye sees for a color painted over a backdrop (both may be translucent; the page is under everything). */
function paint(fg: string, backdrop: Rgba): Rgba {
  const f = parse(fg);
  return [0, 1, 2].map((i) => f[i] * f[3] + backdrop[i] * (1 - f[3])).concat(1) as Rgba;
}
const page = (): Rgba => parse(colors.bg.base);
/** A surface color (a card, a button fill) as it looks on the page. */
const surface = (fill: string): Rgba => paint(fill, page());
const lum = ([r, g, b]: Rgba) => {
  const lin = (c: number) => ((c /= 255) <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
};
const ratio = (a: Rgba, b: Rgba) => {
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};
/** Contrast of text `fg` on a surface fill `bg` that sits on the page. */
const on = (fg: string, bg: string) => ratio(paint(fg, surface(bg)), surface(bg));
const onPage = (fg: string) => ratio(paint(fg, page()), page());

describe('the light mint theme', () => {
  it('Scenario: a pale off-white background', () => {
    expect(lum(parse(colors.bg.base))).toBeGreaterThan(0.9);
  });

  it('the main accent is a mint-teal: green-blue, clearly more green than red', () => {
    const [r, g, b] = parse(colors.accent.default);
    expect(g).toBeGreaterThan(r + 60);
    expect(b).toBeGreaterThan(r + 40);
  });

  it('the glass cards are translucent, so the blur behind them shows', () => {
    for (const fill of [colors.glass.surface, colors.glass.tabBar]) {
      const alpha = parse(fill)[3];
      expect(alpha).toBeGreaterThan(0.3);
      expect(alpha).toBeLessThan(0.9);
    }
  });

  describe('text on the page', () => {
    it.each([
      ['primary', colors.text.primary, 7],
      ['secondary', colors.text.secondary, 4.5],
      ['tertiary', colors.text.tertiary, 4.5],
      ['tab inactive', colors.text.tabInactive, 4.5],
    ])('%s text', (_n, fg, min) => expect(onPage(fg)).toBeGreaterThanOrEqual(min));
  });

  describe('text on a glass card', () => {
    const card = colors.glass.surface;
    it.each([
      ['primary', colors.text.primary, 7],
      ['secondary', colors.text.secondary, 4.5],
      ['tertiary', colors.text.tertiary, 4.5],
      ['card summary', colors.card.summary, 4.5],
      ['card readers', colors.card.readers, 4.5],
      ['list meta', colors.list.meta, 4.5],
      ['list date', colors.list.date, 4.5],
      ['list empty text', colors.list.emptyBody, 4.5],
      ['detail summary label', colors.detail.summaryLabel, 4.5],
      ['detail summary text', colors.detail.summaryText, 4.5],
      ['detail meta', colors.detail.meta, 4.5],
      ['detail section label', colors.detail.sectionLabel, 4.5],
      ['detail people industry', colors.detail.peopleIndustry, 4.5],
      ['state panel body', colors.statePanel.body, 4.5],
      ['form label', colors.form.label, 4.5],
      ['form hint', colors.form.hint, 4.5],
      ['form error', colors.form.error, 4.5],
    ])('%s', (_n, fg, min) => expect(on(fg, card)).toBeGreaterThanOrEqual(min));
  });

  describe('text on its own colored surface', () => {
    it.each([
      ['Save button text', colors.button.save.text, colors.button.save.bg],
      ['detail save text', colors.detail.saveText, colors.detail.saveBg],
      ['selected chip text', colors.form.chipSelectedText, colors.form.chipSelectedBg],
      ['primary state button', colors.statePanel.primaryText, colors.statePanel.primaryBg],
      ['Open original button', colors.detail.openText, colors.detail.openBg],
      ['tab badge', colors.badge.text, colors.badge.bg],
      ['SAVE swipe label', colors.swipe.save.labelText, colors.swipe.save.labelBg],
      ['SKIP swipe label', colors.swipe.skip.labelText, colors.swipe.skip.labelBg],
      ['unread inbox time', colors.inbox.unreadTime, colors.inbox.unreadBg],
      ['inbox industry', colors.inbox.industry, colors.inbox.readBg],
      ['read inbox subject', colors.inbox.subjectRead, colors.inbox.readBg],
      ['inbox preview', colors.inbox.preview, colors.inbox.readBg],
      ['sheet send', colors.sheet.send, colors.sheet.bg],
      ['sheet cancel', colors.sheet.cancel, colors.sheet.bg],
      ['sheet label', colors.sheet.label, colors.sheet.bg],
      ['toast text', colors.text.primary, colors.sheet.toastBg],
      ['form menu text', colors.text.primary, colors.form.menuBg],
    ])('%s is readable on its fill', (_n, fg, bg) => expect(on(fg, bg)).toBeGreaterThanOrEqual(4.5));

    it.each(Object.entries(colors.tag))('the %s tag is readable', (_name, tag) => expect(on(tag.fg, tag.bg)).toBeGreaterThanOrEqual(4.5));
    // A logo badge holds one large bold letter, so the 3:1 that large text needs is the bar.
    it.each(Object.entries(colors.brand))('the %s logo letter is readable on its badge', (_name, b) => expect(ratio(parse(b.fg), parse(b.bg))).toBeGreaterThanOrEqual(3));
  });

  it('the logo badges of pale brands do not melt into the pale page', () => {
    for (const name of ['OpenAI', 'BlackRock', 'Andreessen Horowitz'] as const) {
      expect(ratio(parse(colors.brand[name].bg), parse(colors.bg.base))).toBeGreaterThan(3);
    }
  });

  it('the rating chips and the muted text of the list course read on their fills', () => {
    const c = colors.course;
    expect(on(c.strong.fg, c.strong.bg)).toBeGreaterThanOrEqual(4.5);
    expect(on(c.thin.fg, c.thin.bg)).toBeGreaterThanOrEqual(4.5);
    expect(onPage(c.missing.fg)).toBeGreaterThanOrEqual(4.5);
    expect(onPage(c.muted)).toBeGreaterThanOrEqual(4.5);
    expect(on(c.library.fg, c.library.bg)).toBeGreaterThanOrEqual(4.5);
    expect(onPage(c.kicker)).toBeGreaterThanOrEqual(4.5);
  });
});
