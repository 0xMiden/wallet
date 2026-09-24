import { Keyboard } from '@capacitor/keyboard';

import { isIOS, isMobile } from 'lib/platform';

import { holdNavbarHidden } from './useHideNavbarWhileOpen';

/**
 * Keyboard inset for mobile.
 *
 * The `--keyboard-height` mirror is iOS only; the keyboardWillShow/keyboardWillHide
 * listeners and the bottom-nav hold they take run on iOS and Android.
 *
 * Capacitor's Keyboard resize mode is 'none' (capacitor.config.ts),
 * but that only overlays the keyboard on iOS: the WKWebView keeps its full
 * height, so the soft keyboard hides bottom-of-layout inputs/CTAs. This module
 * mirrors the keyboard height into the `--keyboard-height` CSS var on <html>;
 * mobile.html's body padding-bottom consumes it via
 * `max(var(--app-safe-bottom), var(--keyboard-height, 0px))`, so the
 * full-height layout shrinks and bottom-pinned content rides above the keyboard.
 * Fixed-position surfaces (the bottom-sheet drawers in `lib/ui/drawer.tsx`)
 * sit outside the body padding and consume the var in their own
 * padding-bottom instead; keyboard-adjacent CTA footers (send flow) subtract
 * it from their bottom cushion so the button stays snug against the keyboard.
 * `keyboardWillShow` fires before the native slide with the final height, so
 * the layout snaps to its final inset once, before the keyboard moves. The
 * padding is deliberately NOT transitioned: padding is a layout property, and
 * animating it made WebKit reflow the page tree on every frame of the slide.
 *
 * Android is DELIBERATELY excluded from the height mirror: `resize: 'none'` is
 * only a JS-layer setting there — the native window stays ADJUST_RESIZE
 * (see AndroidManifest's MainActivity), so the system already resizes the
 * WebView to sit above the keyboard. Adding the CSS inset on top of that
 * double-counts the keyboard height: the layout collapses into a thin strip at
 * the top with an empty gap above the keyboard. So `--keyboard-height` is left
 * at 0 on Android and the native resize does the work. The listeners still
 * register there, so the navbar is held hidden while the keyboard is up.
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

  // The keyboard's hold on the hidden navbar lives here, not in React: taking and releasing it in
  // the same callback that writes the inset means the inset, the CTA cushion and the bar change in
  // one task, so on iOS the pinned CTA makes one move on open AND on close. The height is mirrored
  // on iOS only: on Android the native ADJUST_RESIZE already lifts the layout above the keyboard
  // (before this listener runs), so mirroring it would double-count, and the CTA takes two slides.
  const ios = isIOS();
  let releaseNavbar: (() => void) | undefined;
  // A surviving listener can still fire until its remove() settles.
  let active = true;
  const hide = () => {
    if (ios) root.style.setProperty('--keyboard-height', '0px');
    releaseNavbar?.();
    releaseNavbar = undefined;
  };
  // Registered in one tick so no WillHide lands between the two, and kept only as a pair: a
  // WillShow without its WillHide would take a navbar hold nothing releases.
  const registrations = await Promise.allSettled([
    Keyboard.addListener('keyboardWillShow', info => {
      if (!active) return;
      if (ios) root.style.setProperty('--keyboard-height', `${info.keyboardHeight || 0}px`);
      // A keyboard type change reports WillShow again without a hide: one hold, not two.
      releaseNavbar ??= holdNavbarHidden();
    }),
    Keyboard.addListener('keyboardWillHide', hide)
  ]);
  if (registrations.some(result => result.status === 'rejected')) {
    // Keyboard plugin has no web implementation - run without insets rather
    // than failing mobile app init.
    active = false;
    hide();
    await Promise.allSettled(
      registrations.flatMap(result => (result.status === 'fulfilled' ? [result.value.remove()] : []))
    );
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
      if (document.activeElement !== target) return;
      // A field that is already on screen (the header search, a top form row)
      // must not move: the smooth scroll shows as a second jump after the
      // keyboard inset has settled.
      const rect = target.getBoundingClientRect();
      const viewport = window.visualViewport;
      const top = viewport ? viewport.offsetTop : 0;
      const bottom = viewport ? viewport.offsetTop + viewport.height : window.innerHeight;
      if (rect.top >= top && rect.bottom <= bottom) return;
      target.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }, 300);
  });
}
