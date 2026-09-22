import { clsx, type ClassValue } from 'clsx';
import { extendTailwindMerge } from 'tailwind-merge';

import { TYPE_STYLES } from './type-styles';

/**
 * Wipes the clipboard, used after a secret is pasted (see `ImportAccount`'s private-key field).
 *
 * The write is owned by an async function, so an absent `navigator.clipboard` - where the
 * DEREFERENCE throws before any promise exists - becomes a rejection rather than an exception out
 * of the paste handler. The settled promise is returned so a caller, and a test, can observe
 * whether the wipe actually happened: a browser refusing the write for lack of transient
 * activation is the common case, and it leaves the secret on the clipboard. It never rejects, so
 * a caller that ignores it (React ignores a handler's return value) creates nothing floating.
 */
export const clearClipboard = async (): Promise<void> => {
  try {
    await window.navigator.clipboard.writeText('');
  } catch (error) {
    // Nothing on screen can report this, but it must not vanish: the secret is still there.
    console.error('[clipboard] failed to clear the clipboard after a secret was pasted:', error);
  }
};

/**
 * A type style replaces an earlier size, line-height, weight, family or tracking class, and a
 * later size replaces it. A later weight or leading modifier is kept beside it: the utility reads
 * `--tw-font-weight` and `--tw-leading`, so the modifier wins in CSS too.
 */
const twMerge = extendTailwindMerge<'type-style'>({
  extend: {
    classGroups: { 'type-style': [{ text: [...TYPE_STYLES] }] },
    conflictingClassGroups: {
      'type-style': ['font-size', 'leading', 'font-weight', 'font-family', 'tracking'],
      'font-size': ['type-style']
    }
  }
});

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
