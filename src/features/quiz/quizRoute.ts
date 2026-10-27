/**
 * How the quiz screen is presented. It covers the article and cannot be swiped away: the swipe-back gesture
 * is off, so the only ways out are the Article pill and Close or Done on the result. Leaving by any route drops
 * the run, because nothing is saved until the result of a passed quiz.
 */
export const QUIZ_SCREEN_OPTIONS = {
  presentation: 'fullScreenModal',
  animation: 'slide_from_bottom',
  gestureEnabled: false,
} as const;
