import React, { FC, useCallback, useEffect, useRef, useState } from 'react';

import classNames from 'clsx';
import { useTranslation } from 'react-i18next';

import { Icon, IconName } from 'app/icons/v2';
import { countDeadletteredNotes } from 'lib/miden/note-deadletter';
import { hapticLight } from 'lib/mobile/haptics';
import { WalletMessageType } from 'lib/shared/types';
import { getIntercom } from 'lib/store';
import { useRetryableSWR } from 'lib/swr';

export interface DeadletteredNotesNoticeProps {
  className?: string;
}

/**
 * How long a drain may hold the button disabled. The intercom request has no
 * deadline of its own and an MV3 worker teardown drops an in-flight one without
 * rejecting it, so an unbounded guard turns one unlucky press into a Retry the
 * user can never press again this session. Generous, because a drain of a full
 * store is a read-modify-write per note and re-enabling under a live drain is
 * the thing the guard exists to prevent.
 */
const RETRY_GUARD_MAX_MS = 60_000;

/**
 * The drain surface for the note dead-letter store (#788 follow-up): notes the
 * wallet gave up importing automatically — whose bytes can be the only copy of
 * the funds they carry — surface here with a Retry, which is the manual drain
 * the store's refuse-at-cap contract assumes exists.
 *
 * The SIGNAL is read straight from storage on an SWR poll: the store lives in
 * the same layer on every platform (browser.storage.local / Capacitor
 * Preferences / prefixed localStorage), so no backend round trip is needed to
 * know the count, and polling works identically on the platforms that have no
 * storage-changed event. The DRAIN goes through the intercom action, because
 * the queue's writes must happen in the realm that owns the import pass — the
 * SW on extension — and a popup-side write would race its read-modify-writes.
 */
export const DeadletteredNotesNotice: FC<DeadletteredNotesNoticeProps> = ({ className }) => {
  const { t } = useTranslation();
  // Only the COUNT crosses into the component, and it is counted inside the
  // store's own module. The records carry raw note bytes that may be the only
  // copy of the funds they carry, and nothing here renders them — keeping them
  // out of props, the SWR cache and any error-boundary serialization costs
  // nothing and is one fewer place they can leak from.
  const { data, mutate } = useRetryableSWR<number>('deadlettered-notes', () => countDeadletteredNotes(), {
    refreshInterval: 10_000
  });

  const count = data ?? 0;
  const [retrying, setRetrying] = useState(false);
  // Set in the effect BODY, not just cleared in the cleanup: StrictMode invokes
  // setup, cleanup, setup, so an initializer-only `true` is false forever after
  // the first simulated unmount and the Retry button never re-enables.
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const onRetry = useCallback(() => {
    // Guarded against a second press, and not merely for tidiness: each drain
    // supersedes any import pass in flight, so N concurrent drains discard N-1
    // passes' banked attempts and backoff stamps. The count also cannot go to
    // zero until the drain returns, so an impatient user sees a live Retry over
    // a store that is already being emptied.
    if (retrying) return;
    setRetrying(true);
    hapticLight();
    let guard: ReturnType<typeof setTimeout>;
    const release = () => {
      clearTimeout(guard);
      if (mounted.current) setRetrying(false);
    };
    const timeout = new Promise<void>(resolve => {
      guard = setTimeout(resolve, RETRY_GUARD_MAX_MS);
    });
    void Promise.race([
      getIntercom()
        .request({ type: WalletMessageType.RetryDeadletteredNotesRequest })
        .catch(() => {})
        // Revalidate regardless of outcome: a partial drain (queue write failed
        // mid-way) leaves a smaller store, and the count shown should say so.
        .then(() => mutate())
        .catch(() => {}),
      timeout
    ]).then(release, release);
  }, [mutate, retrying]);

  if (count === 0) return null;

  return (
    <div
      className={classNames('min-h-[56px] flex items-center bg-white px-4 gap-x-2 py-2 rounded-2xl', className)}
      data-testid="deadlettered-notes-notice"
    >
      <div className="flex items-center">
        <Icon name={IconName.WarningFill} size="md" fill="#FEA644" />
      </div>
      <div className="flex-1 flex flex-col justify-center items-start min-w-0">
        <p className="text-black text-sm font-medium">
          {count === 1 ? t('deadletteredNotesTitleOne') : t('deadletteredNotesTitle')}
        </p>
        <p className="text-text-muted text-xs">
          {count === 1 ? t('deadletteredNotesBodyOne') : t('deadletteredNotesBody', { count })}
        </p>
      </div>
      <button
        type="button"
        onClick={onRetry}
        disabled={retrying}
        className="text-xs font-medium text-primary-500 px-2 py-1 rounded-md hover:bg-gray-100 disabled:opacity-50"
      >
        {t('connectivityRetry')}
      </button>
    </div>
  );
};
