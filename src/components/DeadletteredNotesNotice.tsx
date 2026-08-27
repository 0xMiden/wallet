import React, { FC, useCallback, useState } from 'react';

import classNames from 'clsx';
import { useTranslation } from 'react-i18next';

import { Icon, IconName } from 'app/icons/v2';
import { DeadletteredNote, listDeadletteredNotes } from 'lib/miden/note-deadletter';
import { hapticLight } from 'lib/mobile/haptics';
import { WalletMessageType } from 'lib/shared/types';
import { getIntercom } from 'lib/store';
import { useRetryableSWR } from 'lib/swr';

export interface DeadletteredNotesNoticeProps {
  className?: string;
}

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
  const { data, mutate } = useRetryableSWR<DeadletteredNote[]>('deadlettered-notes', () => listDeadletteredNotes(), {
    refreshInterval: 10_000
  });

  const count = data?.length ?? 0;
  const [retrying, setRetrying] = useState(false);

  const onRetry = useCallback(() => {
    // Guarded against a second press, and not merely for tidiness: each drain
    // supersedes any import pass in flight, so N concurrent drains discard N-1
    // passes' banked attempts and backoff stamps. The count also cannot go to
    // zero until the drain returns, so an impatient user sees a live Retry over
    // a store that is already being emptied.
    if (retrying) return;
    setRetrying(true);
    hapticLight();
    void getIntercom()
      .request({ type: WalletMessageType.RetryDeadletteredNotesRequest })
      .catch(() => {})
      // Revalidate regardless of outcome: a partial drain (queue write failed
      // mid-way) leaves a smaller store, and the count shown should say so.
      .then(() => mutate())
      .catch(() => {})
      .then(() => setRetrying(false));
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
        <p className="text-black text-sm font-medium">{t('deadletteredNotesTitle')}</p>
        <p className="text-text-muted text-xs">{t('deadletteredNotesBody', { count })}</p>
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
