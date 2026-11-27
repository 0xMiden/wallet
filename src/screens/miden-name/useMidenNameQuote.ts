import { useCallback, useEffect, useState } from 'react';

import { type MidenLabelError, normalizeMidenNameInput, validateMidenLabel } from 'lib/miden/name/encoding';
import { fetchMidenNameQuote, type MidenNameQuote } from 'lib/miden/name/reads';

/** Time (ms) from the last key press to the quote read. */
export const MIDEN_NAME_QUOTE_DEBOUNCE_MS = 350;

export type MidenNameQuoteStatus = 'idle' | 'invalid' | 'checking' | 'available' | 'taken' | 'unsupported' | 'error';

export interface MidenNameQuoteState {
  status: MidenNameQuoteStatus;
  /** The normalized label (no `.miden` suffix). Empty when the input is empty. */
  label: string;
  /** Why the label is not valid. Set only for `invalid`. */
  reason?: MidenLabelError;
  /**
   * The last quote that the hook read. During `checking` it can be the quote of
   * an other label: the screen keeps it on show so that the rows do not flicker.
   */
  quote?: MidenNameQuote;
  /** Read the quote of the current label again (for example after a failed submit). */
  recheck: () => void;
}

type ResolvedStatus = Exclude<MidenNameQuoteStatus, 'idle' | 'invalid' | 'checking' | 'error'>;

function statusOfQuote(quote: MidenNameQuote): ResolvedStatus {
  switch (true) {
    case !quote.available:
      return 'taken';
    case !quote.scriptAllowed:
      return 'unsupported';
    default:
      return 'available';
  }
}

interface InnerState {
  status: MidenNameQuoteStatus;
  label: string;
  quote?: MidenNameQuote;
}

/**
 * Read the Miden Name quote of the user input. The read starts 350 ms after the
 * last change. A change or an unmount aborts the read in progress, so that a
 * late result for an old label is never shown.
 */
export function useMidenNameQuote(input: string): MidenNameQuoteState {
  const label = normalizeMidenNameInput(input);
  const reason = validateMidenLabel(label);
  const [state, setState] = useState<InnerState>({ status: 'idle', label: '' });
  const [nonce, setNonce] = useState(0);

  const recheck = useCallback(() => setNonce(value => value + 1), []);

  useEffect(() => {
    if (reason !== null) return undefined;

    const controller = new AbortController();
    setState(previous => ({ status: 'checking', label, quote: previous.quote }));

    const timer = setTimeout(async () => {
      try {
        const quote = await fetchMidenNameQuote(label);
        if (controller.signal.aborted) return;
        setState({ status: statusOfQuote(quote), label, quote });
      } catch (error) {
        if (controller.signal.aborted) return;
        console.warn('[miden-name] quote read failed', error);
        setState(previous => ({ status: 'error', label, quote: previous.quote }));
      }
    }, MIDEN_NAME_QUOTE_DEBOUNCE_MS);

    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [label, reason, nonce]);

  switch (true) {
    case label.length === 0:
      return { status: 'idle', label, quote: state.quote, recheck };
    case reason !== null:
      return { status: 'invalid', label, reason: reason ?? undefined, quote: state.quote, recheck };
    case state.label !== label:
      // The effect for the new label did not run yet.
      return { status: 'checking', label, quote: state.quote, recheck };
    default:
      return { status: state.status, label, quote: state.quote, recheck };
  }
}
