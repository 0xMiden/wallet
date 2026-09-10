import { useCallback, useEffect, useRef, useState } from 'react';

export default function useCopyToClipboard<T extends HTMLInputElement | HTMLTextAreaElement = HTMLInputElement>(
  copyDelay: number = 1000 * 2
) {
  const fieldRef = useRef<T>(null);

  const [copied, setCopied] = useState(false);

  const copiedTimeoutRef = useRef<number>();
  const copyInFlightRef = useRef(false);
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

  const copy = useCallback(() => {
    if (copied || copyInFlightRef.current) return;

    const textarea = fieldRef.current;

    if (textarea) {
      textarea.focus();
      textarea.select();
      copyInFlightRef.current = true;
      const writeText = navigator.clipboard?.writeText;
      if (!writeText) {
        setCopied(false);
        copyInFlightRef.current = false;
        return;
      }

      try {
        writeText.call(navigator.clipboard, textarea.value).then(
          () => {
            setCopied(true);
            copyInFlightRef.current = false;
          },
          () => {
            setCopied(false);
            copyInFlightRef.current = false;
          }
        );
      } catch {
        setCopied(false);
        copyInFlightRef.current = false;
      }
    }
  }, [copied, setCopied]);

  return { fieldRef, copied, setCopied, copy };
}
