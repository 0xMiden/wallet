/**
 * Hook for registering a primary action button on the native navbar
 * overlay (MidenNavbarOverlayWindow). Pages that have a "primary CTA
 * at the bottom of the screen" — Send's Continue, Receive's Claim All,
 * Faucet's Get Tokens, etc. — call this instead of rendering their own
 * sticky bottom button. The native navbar morphs to compact mode (3
 * nav buttons take 50%, action button fills the other 50%) and the
 * action's tap fires a Capacitor event that this hook routes to the
 * provided onTap callback.
 *
 * Why hoist the button to native:
 * - The navbar is always visible (per the user's design), so a
 *   page-bottom React button would either be hidden behind the navbar
 *   or would force the navbar to move out of the way. Hoisting to
 *   native means one canonical spot for the primary action and a
 *   pixel-perfect liquid-glass morph between modes.
 * - The morph animation is a UIView spring on the constraint flip —
 *   that's the iOS native pattern Apple uses for the system Music
 *   mini-player → full-player morph and the keyboard dictation
 *   toggle. CSS / framer-motion can't reach that quality on a
 *   webview because the layout target is a separate UIWindow.
 *
 * Multi-page handoff: when the user navigates from page A (which
 * registered an action) to page B (which also registers an action),
 * page A's unmount cleanup runs AFTER page B's mount effect. Without
 * a guard, A's unmount would clear the action that B just installed.
 * The "current owner" ref ensures only the page that currently owns
 * the action can clear it.
 *
 * Dynamic update: pages like Receive register the action conditionally
 * (Claim All only appears once a network sync detects claimable notes).
 * Pass `null` to disable; the hook will call clearNavbarAction. When
 * the source-of-truth flips back to a non-null action, the hook
 * morphs back into compact mode.
 */

import { useEffect, useId, useRef } from 'react';

import { InAppBrowser } from '@miden/dapp-browser';

import { isMobile } from 'lib/platform';

export interface NavbarAction {
  /** Visible label, e.g. "Continue", "Claim All". */
  label: string;
  /** Tap handler — called when the user taps the action pill. */
  onTap: () => void;
  /** When false, the button shows greyed out and taps are ignored. */
  enabled?: boolean;
}

// Module-level state. Tracks which hook instance currently owns the
// navbar action so cross-component handoffs (page A → page B) don't
// stomp each other.
let currentOwner: string | null = null;
// The latest registered onTap. Held outside React state so the
// Capacitor event listener (subscribed once below) can dispatch to
// the right callback without re-subscribing.
let currentOnTap: (() => void) | null = null;
let listenerInstalled = false;

function ensureListener(): void {
  if (listenerInstalled || !isMobile()) return;
  listenerInstalled = true;
  void InAppBrowser.addListener('nativeNavbarActionTap', () => {
    currentOnTap?.();
  });
}

export function useNativeNavbarAction(action: NavbarAction | null): void {
  // Each hook instance gets a stable id from React. Used to gate the
  // unmount cleanup so we don't clear an action a successor page
  // installed after our unmount started.
  const ownerId = useId();
  // Hold the latest onTap in a ref so the global listener can call
  // through to it without us needing to re-register on every render.
  const onTapRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    if (!isMobile()) return;
    ensureListener();

    if (action) {
      // Take ownership and push the action to native.
      currentOwner = ownerId;
      currentOnTap = action.onTap;
      onTapRef.current = action.onTap;
      void InAppBrowser.setNavbarAction({
        label: action.label,
        enabled: action.enabled ?? true
      });
    } else if (currentOwner === ownerId) {
      // We had ownership but our action is now null — release it.
      currentOwner = null;
      currentOnTap = null;
      onTapRef.current = null;
      void InAppBrowser.clearNavbarAction();
    }

    return () => {
      // Only clear if we still own the slot. If a successor page has
      // already taken over (current owner is someone else's id), the
      // navbar already shows their action and we should leave it alone.
      if (currentOwner === ownerId) {
        currentOwner = null;
        currentOnTap = null;
        onTapRef.current = null;
        void InAppBrowser.clearNavbarAction();
      }
    };
    // Re-run on every change of label / enabled / onTap reference so
    // the native button stays in sync with React state.
  }, [ownerId, action?.label, action?.enabled, action?.onTap]);
}
