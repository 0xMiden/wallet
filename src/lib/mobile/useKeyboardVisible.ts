import { useEffect, useState } from 'react';

import type { PluginListenerHandle } from '@capacitor/core';
import { Keyboard } from '@capacitor/keyboard';

import { isMobile } from 'lib/platform';

/**
 * True while the mobile soft keyboard is up (tracked via the
 * `@capacitor/keyboard` will-show/will-hide events, so it flips before the
 * native slide animation). Always false on extension/desktop.
 */
export function useKeyboardVisible(): boolean {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (!isMobile()) return;

    let cancelled = false;
    const handles: PluginListenerHandle[] = [];

    (async () => {
      try {
        const show = await Keyboard.addListener('keyboardWillShow', () => setVisible(true));
        const hide = await Keyboard.addListener('keyboardWillHide', () => setVisible(false));
        if (cancelled) {
          show.remove();
          hide.remove();
          return;
        }
        handles.push(show, hide);
      } catch {
        // Keyboard plugin has no web implementation — treat as never visible
        // (jsdom tests and any non-native context where isMobile() is true).
      }
    })();

    return () => {
      cancelled = true;
      handles.forEach(handle => handle.remove());
    };
  }, []);

  return visible;
}
