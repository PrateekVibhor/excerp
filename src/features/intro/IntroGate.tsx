import { useEffect, useState, type ReactNode } from 'react';
import { Modal } from 'react-native';
import { introStore as defaultStore } from '../../data';
import type { IntroStore } from '../../data/introChoice';
import { ScreenBackground } from '../../components/ScreenBackground';
import { IntroCards } from './IntroCards';

/** How long the stored choice may take to read before the cards show anyway. */
const READ_MS = 400;
/** Set once the cards have been dealt with in this run of the app, so they come back on the next cold start and not when the app is left and returned to, or the gate remounts. */
let dealtWith = false;
export const resetIntroForTests = () => {
  dealtWith = false;
};

/**
 * The intro cards, over the app, once per cold start unless the reader chose not to see them again. It belongs inside the sign-in gate, so it is never over the sign-in
 * screen, and the app underneath loads at once: reading the stored choice only decides whether the cards cover it. A storage that is slow or fails shows the cards.
 */
export function IntroGate({ children, store = defaultStore }: { children: ReactNode; store?: IntroStore }) {
  const [phase, setPhase] = useState<'reading' | 'cards' | 'done'>(dealtWith ? 'done' : 'reading');

  useEffect(() => {
    if (phase !== 'reading') return;
    let live = true;
    const timer = setTimeout(() => live && setPhase('cards'), READ_MS);
    Promise.resolve()
      .then(() => store.isHidden())
      .then(
        (hidden) => {
          if (!live) return;
          clearTimeout(timer);
          if (hidden) dealtWith = true;
          setPhase(hidden ? 'done' : 'cards');
        },
        () => {}, // the timer shows the cards
      );
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [phase, store]);

  const leave = (hideNextTime: boolean) => {
    dealtWith = true;
    setPhase('done');
    if (hideNextTime) void Promise.resolve().then(() => store.hide()).catch(() => {});
  };

  return (
    <>
      {children}
      {phase !== 'done' && (
        <Modal visible animationType="none" statusBarTranslucent onRequestClose={() => leave(false)}>
          {phase === 'cards' ? <IntroCards onDone={leave} /> : <ScreenBackground>{null}</ScreenBackground>}
        </Modal>
      )}
    </>
  );
}
