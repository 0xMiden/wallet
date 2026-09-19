import { clsx, type ClassValue } from 'clsx';
import { extendTailwindMerge } from 'tailwind-merge';

import { TYPE_STYLES } from './type-styles';

export const clearClipboard = () => {
  window.navigator.clipboard.writeText('');
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
