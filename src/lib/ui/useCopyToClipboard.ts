import { useCallback, useEffect, useRef, useState } from 'react';

export default function useCopyToClipboard<T extends HTMLInputElement | HTMLTextAreaElement = HTMLInputElement>(
  copyDelay: number = 1000 * 2
) {
  const fieldRef = useRef<T>(null);

  const [copied, setCopied] = useState(false);

  const copiedTimeoutRef = useRef<number>();
  useEffect(() => {
    if (copied) {
      copiedTimeoutRef.current = window.setTimeout(() => {
        setCopied(false);
        const textarea = fieldRef.current;
        if (textarea && document.activeElement === textarea) {
          textarea.blur();
        }
      }, copyDelay);
    }

    return () => {
      clearTimeout(copiedTimeoutRef.current);
    };
  }, [copied, setCopied, copyDelay]);

  // `copied` cannot hold the second activation off any more: it is only set once the write
  // RESOLVES, so a second click inside that window would re-focus, re-select and write again. This
  // is set synchronously, before the write, and is what keeps that click a no-op.
  const inFlightRef = useRef(false);

  const copy = useCallback(() => {
    if (copied || inFlightRef.current) return;

    const textarea = fieldRef.current;

    if (textarea) {
      textarea.focus();
      textarea.select();
      inFlightRef.current = true;
      // The confirmation follows the WRITE. Reporting it beforehand told the user their secret was
      // on the clipboard whenever the write was refused - the costliest place to be wrong.
      //
      // The write is owned by an async function rather than chained off the bare call, so that a
      // `navigator.clipboard` that is absent - which makes the DEREFERENCE throw, before any
      // promise exists - becomes a rejection `.catch` swallows and `.finally` releases, instead of
      // throwing into the click handler and stranding the latch for the life of the component.
      // An async body runs synchronously to its first `await`, so `writeText` is still called in
      // the activation's own stack (WebKit refuses a clipboard write outside it) and
      // `textarea.value` is still read at click time. `copy` stays void-returning, so no caller's
      // signature changes; on a failure the value stays selected, to be copied by hand.
      void (async () => {
        await navigator.clipboard.writeText(textarea.value);
        setCopied(true);
      })()
        .catch(() => {})
        .finally(() => {
          inFlightRef.current = false;
        });
    }
  }, [copied, setCopied]);

  return { fieldRef, copied, setCopied, copy };
}
