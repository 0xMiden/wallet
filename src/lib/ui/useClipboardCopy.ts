import { useEffect, useRef, useState } from 'react';

import { Clipboard } from '@capacitor/clipboard';

const COPIED_FEEDBACK_MS = 1500;

/**
 * Writes `text` to the clipboard via `@capacitor/clipboard` (which ships its own web
 * implementation, so the same call is correct on desktop, the extension and every mobile
 * webview) and flips `copied` true for a beat afterward. Shared by `CopyButton` (the text
 * action) and `CopyChip` (the Pill with copy) so both read from one clipboard/feedback
 * implementation instead of two.
 *
 * Does not fire a haptic itself — callers differ on when: `CopyButton` fires it directly,
 * `CopyChip` gets it from `Pill`'s own tap handler, and firing it here too would double it.
 */
export function useClipboardCopy(text: string) {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout>>();
  // A write that resolves after the component has already unmounted (e.g. the row it copied from
  // disappeared, or the page navigated away) must not set state or arm a timeout nobody will ever
  // clear — both are a no-op-but-warn in React and, for the timer, a dangling callback that fires
  // into a dead closure.
  const mountedRef = useRef(true);

  useEffect(
    () => () => {
      mountedRef.current = false;
      clearTimeout(timerRef.current);
    },
    []
  );

  const copy = async () => {
    try {
      await Clipboard.write({ string: text });
      if (!mountedRef.current) return;
      setCopied(true);
      clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => setCopied(false), COPIED_FEEDBACK_MS);
    } catch {
      // Nothing to report — the value stays on screen to copy by hand.
    }
  };

  return { copied, copy };
}
