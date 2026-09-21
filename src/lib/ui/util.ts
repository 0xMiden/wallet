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
 *
 * `max-w-cta` (the CTA cap, `--container-cta` in main.css) joins Tailwind's own `max-w` group:
 * it is a theme key tailwind-merge does not ship, so without this a caller's `max-w-none` would
 * be emitted BESIDE the cap instead of replacing it, and which one won would be a question about
 * the order the stylesheet happened to emit them in.
 */
const twMerge = extendTailwindMerge<'type-style'>({
  extend: {
    classGroups: { 'type-style': [{ text: [...TYPE_STYLES] }], 'max-w': ['max-w-cta'] },
    conflictingClassGroups: {
      'type-style': ['font-size', 'leading', 'font-weight', 'font-family', 'tracking'],
      'font-size': ['type-style']
    }
  }
});

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
