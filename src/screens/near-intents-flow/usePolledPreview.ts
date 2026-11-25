import { useEffect, useRef, useState } from 'react';

/** The wait after the last change to the key before the hook asks for a preview. */
export const PREVIEW_DEBOUNCE_MS = 350;
/** The wait after an answer (or a failure) before the hook asks again for the same key, while it is active. */
export const PREVIEW_REFRESH_MS = 30_000;

export interface PolledPreview<T> {
  /** The latest answer for the current key. Undefined while the hook is paused or the key has no answer yet. */
  value?: T;
  /** The failure of the last request for the current key. A later answer clears it. */
  error?: Error;
  loading: boolean;
}

interface PolledState<T> {
  key: string;
  value?: T;
  error?: Error;
  loading: boolean;
}

/**
 * A preview that the hook asks for after `PREVIEW_DEBOUNCE_MS`, and again `PREVIEW_REFRESH_MS` after each request
 * settles, so two requests never overlap. A change of `key`, a pause (`active` false) or an unmount aborts the request
 * on its way and ignores its answer. An empty `key` means there is nothing to ask for. A paused hook or an answer for
 * another key is hidden: the hook returns no value. A refresh of the same key keeps the last value until the answer.
 */
export function usePolledPreview<T>(
  key: string,
  active: boolean,
  load: (signal: AbortSignal) => Promise<T>
): PolledPreview<T> {
  const [state, setState] = useState<PolledState<T>>({ key: '', loading: false });
  const loadRef = useRef(load);
  loadRef.current = load;
  const enabled = active && key !== '';

  useEffect(() => {
    if (!enabled) {
      setState(previous =>
        previous.key === '' && !previous.loading && previous.value === undefined && previous.error === undefined
          ? previous
          : { key: '', loading: false }
      );
      return;
    }

    // A new key clears the value; a refresh of the same key keeps it until the answer comes.
    setState(previous => (previous.key === key ? { ...previous, loading: true } : { key, loading: true }));

    let stopped = false;
    let timer: number | undefined;
    let controller: AbortController | undefined;
    const run = async () => {
      controller = new AbortController();
      setState(previous => (previous.key === key ? { ...previous, loading: true } : previous));
      try {
        const value = await loadRef.current(controller.signal);
        if (stopped) return;
        setState({ key, value, loading: false });
      } catch (error) {
        if (stopped) return;
        setState(previous => ({
          key,
          value: previous.key === key ? previous.value : undefined,
          loading: false,
          error: error instanceof Error ? error : new Error(String(error))
        }));
      }
      timer = window.setTimeout(run, PREVIEW_REFRESH_MS);
    };
    timer = window.setTimeout(run, PREVIEW_DEBOUNCE_MS);

    return () => {
      stopped = true;
      window.clearTimeout(timer);
      controller?.abort();
    };
  }, [key, enabled]);

  if (!enabled) return { loading: false };
  if (state.key !== key) return { loading: true };
  return { value: state.value, error: state.error, loading: state.loading };
}
