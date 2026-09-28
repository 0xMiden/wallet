import { useCallback, useEffect, useRef, useState } from 'react';

import { Clipboard } from '@capacitor/clipboard';

import { COPY_FEEDBACK_MS } from 'lib/animation/copy';

export type ClipboardCopyStatus = 'idle' | 'success' | 'failure';

/**
 * Writes `text` to the clipboard via `@capacitor/clipboard` - one call for every surface, backed by
 * the native bridge on iOS and Android, and by `navigator.clipboard` on desktop and the extension,
 * where it fails in the same places a direct call would. Shared by `CopyButton`, `CopyChip`, the
 * Receive share fallback, the seed-phrase backup and the hot-key error prompt, so they write through
 * one clipboard implementation; each decides its own feedback (`copied` on the buttons, chip and
 * backup, `status` on the hot-key prompt, none on the Receive fallback).
 *
 * `status` is `'success'` once the write resolves, or `'failure'` once it rejects (the error is
 * logged), and either decays to `'idle'` after `COPY_FEEDBACK_MS`; a newer outcome replaces the
 * older one's timer, so a failure is never erased early by an earlier success. `copied` is
 * `status === 'success'`. Both follow `text`: a `copy()` of the text already being written is
 * ignored, and its latch released however that write settles, while a text rendered since writes
 * at once; an outcome is reported only while its own text is the one rendered.
 *
 * Does not fire a haptic itself — callers differ on when: `CopyButton` fires it directly,
 * `CopyChip` gets it from `Pill`'s own tap handler, and firing it here too would double it.
 */
export function useClipboardCopy(text: string) {
  const [outcome, setOutcome] = useState<{ status: 'success' | 'failure'; text: string } | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout>>();
  // The write on its way, not a flag: `text` is a render argument, and a plain latch dropped a value
  // rendered mid-write while the older write went on to report "Copied" beside it.
  const inFlightRef = useRef<{ text: string } | null>(null);
  // A write that settles after the component has already unmounted (e.g. the row it copied from
  // disappeared, or the page navigated away) must not set state or arm a timeout nobody will ever
  // clear — both are a no-op-but-warn in React and, for the timer, a dangling callback that fires
  // into a dead closure.
  const mountedRef = useRef(true);

  useEffect(() => {
    // Also runs on a remount (React 18 Strict Mode's dev-only mount→unmount→remount, or a real
    // remount under the same hook call some other way) — without this, the cleanup below leaves
    // `mountedRef.current` stuck `false` forever after the first unmount, so a `copy()` that
    // resolves after the remount would wrongly take the "unmounted" early return and never show
    // feedback, even though the component is back on screen.
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      clearTimeout(timerRef.current);
    };
  }, []);

  const copy = useCallback(async () => {
    if (inFlightRef.current?.text === text) return;
    const write = { text };
    inFlightRef.current = write;
    let status: 'success' | 'failure';
    try {
      await Clipboard.write({ string: text });
      status = 'success';
    } catch (error) {
      console.error('[clipboard] failed to copy:', error);
      status = 'failure';
    } finally {
      if (inFlightRef.current === write) inFlightRef.current = null;
    }
    if (!mountedRef.current) return;
    setOutcome({ status, text });
    clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => setOutcome(null), COPY_FEEDBACK_MS);
  }, [text]);

  const status: ClipboardCopyStatus = outcome?.text === text ? outcome.status : 'idle';
  return { status, copied: status === 'success', copy };
}
