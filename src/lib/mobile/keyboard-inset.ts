import { Keyboard } from '@capacitor/keyboard';

import { isIOS, isMobile } from 'lib/platform';

/**
 * Keyboard inset for mobile.
 *
 * iOS ONLY. Capacitor's Keyboard resize mode is 'none' (capacitor.config.ts),
 * but that only overlays the keyboard on iOS: the WKWebView keeps its full
 * height, so the soft keyboard hides bottom-of-layout inputs/CTAs. This module
 * mirrors the keyboard height into the `--keyboard-height` CSS var on <html>;
 * mobile.html's body padding-bottom consumes it via
 * `max(16px, env(safe-area-inset-bottom), var(--keyboard-height, 0px))`, so the
 * full-height layout shrinks and bottom-pinned content rides above the keyboard.
 * `keyboardWillShow` fires before the native slide with the final height,
 * letting the CSS transition on body padding run in sync with it.
 *
 * Android is DELIBERATELY excluded from this compensation: `resize: 'none'` is
 * only a JS-layer setting there — the native window stays ADJUST_RESIZE
 * (see AndroidManifest's MainActivity), so the system already resizes the
 * WebView to sit above the keyboard. Adding the CSS inset on top of that
 * double-counts the keyboard height: the layout collapses into a thin strip at
 * the top with an empty gap above the keyboard. So `--keyboard-height` is left
 * at 0 on Android and the native resize does the work.
 */
export async function initKeyboardInset(): Promise<void> {
  if (!isMobile()) return;

  const root = document.documentElement;

  // The iOS number pad has no return key; the WebKit accessory bar (Done +
  // arrows) is the only way to dismiss it. This must be enabled at runtime —
  // there is no `accessoryBarVisible` Keyboard config key (it is silently
  // ignored). No-op on Android; iPhone-only; throws (caught) with no native impl.
  try {
    await Keyboard.setAccessoryBarVisible({ isVisible: true });
  } catch {
    // non-iPhone platform or no native implementation — leave the bar as-is
  }

  // iOS only — on Android the native ADJUST_RESIZE already lifts the layout
  // above the keyboard, so mirroring the height here would double-count it.
  if (isIOS()) {
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
