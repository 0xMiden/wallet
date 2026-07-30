import { Keyboard } from '@capacitor/keyboard';

import { isMobile } from 'lib/platform';

/**
 * Keyboard inset for mobile.
 *
 * Capacitor's Keyboard resize mode is 'none' (capacitor.config.ts), so the
 * soft keyboard overlays the WebView and hides bottom-of-layout inputs/CTAs.
 * This module mirrors the keyboard height into the `--keyboard-height` CSS
 * var on <html>; mobile.html's body padding-bottom consumes it via
 * `max(16px, env(safe-area-inset-bottom), var(--keyboard-height, 0px))`, so
 * the full-height layout shrinks and bottom-pinned content rides above the
 * keyboard. `keyboardWillShow` fires before the native slide with the final
 * height, letting the CSS transition on body padding run in sync with it.
 */
export async function initKeyboardInset(): Promise<void> {
  if (!isMobile()) return;

  const root = document.documentElement;

  try {
    await Keyboard.addListener('keyboardWillShow', info => {
      root.style.setProperty('--keyboard-height', `${info.keyboardHeight || 0}px`);
    });

    await Keyboard.addListener('keyboardWillHide', () => {
      root.style.setProperty('--keyboard-height', '0px');
    });
  } catch {
    // Keyboard plugin has no web implementation — run without insets rather
    // than failing mobile app init.
  }

  // Mid-layout inputs can still sit below the fold after the layout shrinks;
  // nudge the focused field into view once the keyboard animation settles.
  document.addEventListener('focusin', event => {
    const target = event.target;
    if (
      !(target instanceof HTMLElement) ||
      !(target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target.isContentEditable)
    ) {
      return;
    }
    setTimeout(() => {
      if (document.activeElement === target) {
        target.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      }
    }, 300);
  });
}
