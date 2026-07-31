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
        // Track each handle as soon as it registers so cleanup always removes
        // exactly what was created — even if the second registration rejects
        // or the effect unmounts mid-registration.
        const show = await Keyboard.addListener('keyboardWillShow', () => setVisible(true));
        if (cancelled) {
          show.remove();
          return;
        }
        handles.push(show);
        const hide = await Keyboard.addListener('keyboardWillHide', () => setVisible(false));
        if (cancelled) {
          hide.remove();
          return;
        }
        handles.push(hide);
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
