export const radius = { pill: 999, lg: 22, md: 16, sm: 14 } as const;

// `tint` is how the glass frosts what is behind it: 'light' for the pale mint theme.
export const blur = { tabBar: 30, card: 20, tint: 'light' } as const;

export const tabBar = { bottomOffset: 26, padding: 5, gap: 4, sideMargin: 12 } as const;

export const tab = { width: 104, height: 54, iconSize: 22, iconStroke: 1.9 } as const;

/** How far the top of the floating tab bar is above the bottom safe area: its offset, its tabs, its padding and its 1px border on each side. */
export const tabBarTop = tabBar.bottomOffset + tab.height + tabBar.padding * 2 + 2;
/** The room a screen under the tab bar leaves below its last row (or its error line), on top of the bottom safe area: the bar itself and a gap above it. One value for every such screen. */
export const bottomClear = tabBarTop + 58;

export const card = {
  radius: 30,
  padding: 24,
  gap: 18,
  headerGap: 12,
  footerGap: 10,
  monogram: 42,
  monogramRadius: 13,
  tagPaddingV: 7,
  tagPaddingH: 10,
  avatar: 20,
  avatarOverlap: 7,
  avatarBorder: 1.5,
  shadowOffsetY: 30,
  shadowRadius: 30,
  gradientAngle: 160,
  // A longer title is cut with an ellipsis so it cannot push the summary and footer off the card.
  titleLines: 3,
} as const;

// The card needs about 510pt for a 3-line title and a 10-line summary. The wireframe
// leaves 530; here the tab bar sits higher (safe area), so the cards behind the top
// one are allowed to slide under the Save and Skip buttons rather than shrink the card.
export const feed = {
  sidePadding: 20,
  headerGap: 4,
  headerPaddingTop: 6,
  cardAreaTopGap: 14,
  cardAreaBottom: 146,
  stackPeek: 30,
} as const;

export const swipe = {
  // A touch that moves at most this far is a tap; moving further is a drag. One number
  // for both, so a touch is always exactly one of them.
  tapMaxDistance: 10,
  threshold: 110,
  verticalDamping: 0.6,
  rotationPerPoint: 0.055,
  flyDistance: 560,
  flyDuration: 420,
  flyDropY: 20,
  buttonDropY: 40,
  springDamping: 14,
  springStiffness: 170,
  ringWidth: 1.5,
  glowDepth: 70,
  // Gradient stops [offset from the edge, share of the glow opacity]: strongest at the edge, easing out.
  glowFalloff: [
    ['0', 1],
    ['0.3', 0.55],
    ['0.65', 0.18],
    ['1', 0],
  ],
  labelTop: 84,
  labelInset: 20,
  labelRotation: 10,
  labelScaleFrom: 0.8,
  labelPaddingV: 8,
  labelPaddingH: 14,
  labelRadius: 12,
  labelBorder: 2,
} as const;

export const stack = { depth: 2, offset: 15, scaleStep: 0.05, fade: 0.3 } as const;

export const actions = {
  height: 52,
  paddingLeft: 18,
  paddingRight: 22,
  gap: 8,
  sideInset: 24,
  bottomAboveSafeArea: 108,
  skipIcon: 18,
  skipIconStroke: 2.4,
  saveIcon: 17,
  saveIconStroke: 2.2,
  scaleGain: 0.1,
  disabledOpacity: 0.35,
} as const;

export const statePanel = {
  radius: 30,
  padding: 32,
  gap: 14,
  circle: 64,
  icon: 26,
  iconStroke: 2,
  buttonHeight: 44,
  buttonPaddingH: 18,
  buttonGap: 10,
  buttonsMarginTop: 8,
} as const;

export const badge = {
  top: 5,
  left: 60,
  minWidth: 18,
  height: 18,
  paddingH: 5,
  popScale: 1.35,
  popUpMs: 90,
  popSpring: { damping: 8, stiffness: 260 },
  maxCount: 99,
} as const;

export const list = {
  sidePadding: 20,
  rowGap: 10,
  rowPadding: 14,
  rowRadius: 22,
  rowInnerGap: 14,
  textGap: 6,
  monogram: 46,
  monogramRadius: 14,
  titleLines: 2,
  chevronWidth: 8,
  chevronHeight: 14,
  chevronTop: 16,
  chevronStroke: 2,
  removeHeight: 28,
  removePaddingH: 12,
  // Space under the last row so it can scroll clear of the floating tab bar.
  bottomClear,
  emptyTop: 40,
  emptyGap: 8,
} as const;

export const detail = {
  backTop: 4,
  backSide: 16,
  backHeight: 44,
  saveIcon: 18,
  saveIconStroke: 2.1,
  savePaddingLeft: 14,
  savePaddingRight: 16,
  // Fade under the status bar and back button so scrolled content does not collide with them.
  topFadeExtra: 14,
  // Points of scrolling over which the top fade goes from invisible to full strength.
  topFadeRamp: 40,
  backPaddingLeft: 12,
  backPaddingRight: 16,
  backGap: 8,
  chevronWidth: 10,
  chevronHeight: 17,
  chevronStroke: 2.5,
  contentTop: 64,
  contentSide: 24,
  contentGap: 20,
  monogram: 52,
  monogramRadius: 16,
  headerGap: 12,
  metaGapRow: 8,
  metaGapColumn: 16,
  summaryPadding: 22,
  summaryRadius: 24,
  summaryGap: 12,
  sectionGap: 10,
  peopleRadius: 22,
  peopleRowPaddingV: 12,
  peopleRowPaddingH: 16,
  peopleAvatar: 40,
  peopleGap: 12,
  peopleTextGap: 3,
  bottomPaddingTop: 20,
  bottomSide: 24,
  bottomPaddingBottom: 16,
  bottomGap: 10,
  openHeight: 56,
  openGap: 8,
  openIcon: 16,
  openIconStroke: 2.3,
  // Space under the content so it can scroll clear of the fixed Open original bar.
  contentBottomClear: 170,
} as const;

export const profile = {
  sidePadding: 24,
  headerGap: 4,
  sectionGap: 22,
  fieldGap: 7,
  inputHeight: 52,
  inputRadius: 16,
  inputPaddingH: 16,
  menuRadius: 16,
  optionHeight: 46,
  chevronWidth: 12,
  chevronHeight: 8,
  checkSize: 16,
  chipHeight: 36,
  chipPaddingH: 14,
  chipGap: 8,
  hintGap: 4,
  saveHeight: 56,
  avatar: 88,
  summaryGap: 10,
  summaryTop: 6,
  pillHeight: 40,
  pillPaddingH: 16,
  // Space under the form so it can scroll clear of the floating tab bar.
  bottomClear,
} as const;

// The inbox button in the Profile header, from the Swipe Feed v3 wireframe.
export const envelope = {
  size: 40,
  icon: 18,
  iconStroke: 2,
  badgeMax: 9,
  badgeRing: 2,
  badgeTop: -7,
  badgeRight: -9,
} as const;

export const inbox = {
  sidePadding: 20,
  rowGap: 10,
  rowPadding: 14,
  rowRadius: 22,
  innerGap: 12,
  avatar: 46,
  textGap: 5,
  topLineGap: 8,
  dot: 8,
  subjectTop: 2,
  headerGap: 4,
  headerTop: 14,
  listTop: 14,
  // Space under the last row so it scrolls clear of the bottom edge.
  bottomClear: 60,
  emptyTop: 56,
  emptyGap: 8,
  emptyIcon: 64,
  emptyIconGlyph: 26,
} as const;

export const message = {
  // Gap between the back button and the first thing on the page.
  top: 18,
  gap: 18,
  subjectTop: 4,
  subjectGap: 10,
  senderAvatar: 48,
  senderPaddingV: 12,
  senderPaddingLeft: 12,
  senderPaddingRight: 16,
  senderGap: 12,
  senderTextGap: 5,
  chevronWidth: 8,
  chevronHeight: 14,
  noteRadius: 24,
  notePaddingV: 18,
  notePaddingH: 22,
  paragraphGap: 12,
  replyIcon: 17,
  replyIconStroke: 2.3,
} as const;

export const sheet = {
  height: 560,
  // Space kept clear above the sheet, below the status bar, so its header is never covered.
  topGap: 8,
  radius: 28,
  padding: 20,
  paddingTop: 10,
  paddingBottom: 40,
  /** Under the sheet while the keyboard is up: the home indicator is covered by the keyboard then. */
  paddingBottomKeyboard: 16,
  gap: 16,
  grabberWidth: 38,
  grabberHeight: 5,
  toRowHeight: 46,
  toRowRadius: 16,
  toRowPaddingH: 12,
  toRowGap: 10,
  toAvatar: 26,
  inputRadius: 14,
  subjectHeight: 48,
  inputPaddingH: 14,
  bodyPadding: 14,
  sendDisabledOpacity: 0.4,
  sendButtonHeight: 56,
  toastTop: 8,
  toastPaddingV: 10,
  toastPaddingH: 16,
  toastDot: 7,
  toastGap: 8,
  toastShowMs: 2200,
} as const;
