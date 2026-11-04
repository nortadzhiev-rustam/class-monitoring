// "Raise hand": the student asks for help; the teacher sees it on their card
// and in the Help queue until either side lowers it.

import { LIMITS } from '../shared/protocol';
import { onPromptAction, removePrompt, showPrompt } from './prompts';
import { changed } from './state';

let note: string | null = null;

/** The help note while the hand is up ('' for none), else null. */
export const handNote = () => note;

export function raiseHand(text = ''): void {
  note = text.slice(0, LIMITS.handNote);
  showPrompt({ id: 'hand', kind: 'hand' });
  changed();
}

export function lowerHand(): void {
  if (note === null) return;
  note = null;
  removePrompt('hand');
  changed();
}

onPromptAction('hand', (_card, action) => {
  if (action === 'lower') lowerHand();
});
