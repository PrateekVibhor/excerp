import type { SwipeDirection } from '../../data';
import { actions, stack, swipe } from '../../theme';

// Pure helpers for the card gesture. Marked as worklets so the gesture can
// call them on the UI thread; they are ordinary functions under Jest.

/** A release counts as a swipe only when it is past the threshold; exactly at it springs back. */
export function decideSwipe(dx: number): SwipeDirection | null {
  'worklet';
  if (dx > swipe.threshold) return 'right';
  if (dx < -swipe.threshold) return 'left';
  return null;
}

const clamp01 = (n: number) => {
  'worklet';
  return Math.min(1, Math.max(0, n));
};

/** 0 to 1 as the card is dragged right toward the threshold. */
export function saveProgress(dx: number): number {
  'worklet';
  return clamp01(dx / swipe.threshold);
}

/** 0 to 1 as the card is dragged left toward the threshold. */
export function skipProgress(dx: number): number {
  'worklet';
  return clamp01(-dx / swipe.threshold);
}

export function rotationDeg(dx: number): number {
  'worklet';
  return dx * swipe.rotationPerPoint;
}

export function dampedY(dy: number): number {
  'worklet';
  return dy * swipe.verticalDamping;
}

/** Label scale grows from 0.8 to 1 with progress. */
export function labelScale(progress: number): number {
  'worklet';
  return swipe.labelScaleFrom + (1 - swipe.labelScaleFrom) * progress;
}

/** 0 to 1 as the card is dragged either way toward the threshold. */
export function dragProgress(dx: number): number {
  'worklet';
  return clamp01(Math.abs(dx) / swipe.threshold);
}

/**
 * How far back a card sits in the stack, in card steps. A card one place
 * behind the top rises to the top position as the top card is dragged away.
 */
export function stackQ(depth: number, progress: number): number {
  'worklet';
  return Math.max(0, depth - progress);
}

export function stackTranslateY(q: number): number {
  'worklet';
  return q * stack.offset;
}

export function stackScale(q: number): number {
  'worklet';
  return 1 - q * stack.scaleStep;
}

export function stackOpacity(q: number): number {
  'worklet';
  return 1 - Math.max(0, q - 1) * stack.fade;
}

/** Save and Skip buttons grow slightly as the card is dragged toward them. */
export function buttonScale(progress: number): number {
  'worklet';
  return 1 + actions.scaleGain * progress;
}
