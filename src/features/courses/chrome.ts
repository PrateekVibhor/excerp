import type { ReactNode } from 'react';

/** What the Skills list tab puts at the top of a course screen in place of the Back button: its own button on the left (the hamburger), a title, and a menu on the right. */
export interface Chrome {
  /** Shown in the middle of the top bar (the list's name). */
  title?: string;
  left: ReactNode;
  right?: ReactNode;
}
