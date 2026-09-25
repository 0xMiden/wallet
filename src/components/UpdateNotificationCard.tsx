import React, { FC, useCallback, useState } from 'react';

import classNames from 'clsx';
import { useTranslation } from 'react-i18next';

import { Icon, IconName } from 'app/icons/v2';
import type { UpdateNotice } from 'lib/update/types';

export interface UpdateNotificationCardProps {
  notice: UpdateNotice;
  onDismiss: () => void;
}

type ActionState = 'idle' | 'loading' | 'failure';

// Store destinations and reload behavior are client policy. Remote metadata
// cannot replace these labels or select a different action.
const actionKey = (platform: UpdateNotice['platform']): string => {
  switch (platform) {
    case 'android':
      return 'updateNotificationActionAndroid';
    case 'ios':
      return 'updateNotificationActionIos';
    default:
      return 'updateNotificationActionChrome';
  }
};

export const UpdateNotificationCard: FC<UpdateNotificationCardProps> = ({ notice, onDismiss }) => {
  const { t } = useTranslation();
  const [actionState, setActionState] = useState<ActionState>('idle');

  const runAction = useCallback(async () => {
    setActionState('loading');
    try {
      await notice.action();
      setActionState('idle');
    } catch {
      setActionState('failure');
    }
  }, [notice]);

  const actionLabel = actionState === 'failure' ? t('retry') : t(actionKey(notice.platform));

  return (
    // Urgency selects only fixed local styles. It never removes dismissal,
    // blocks the wallet, or changes the user-initiated action.
    <section
      role="status"
      aria-live="polite"
      data-testid="update-notification-card"
      data-urgency={notice.urgency}
      className={classNames(
        'pointer-events-auto w-full rounded-2xl border-2 bg-surface-page p-4 shadow-[0_12px_40px_rgba(0,0,0,0.18)]',
        notice.urgency === 'normal' && 'border-border-button',
        notice.urgency === 'important' && 'border-primary-orange-light bg-primary-orange-lighter',
        notice.urgency === 'critical' && 'border-status-negative'
      )}
    >
      <div className="flex items-start gap-3">
        <span className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-full bg-accent-primary/10 text-accent-primary">
          <Icon name={IconName.Download} size="sm" fill="currentColor" />
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="font-heading text-base font-bold text-text-primary-token">{t('updateNotificationTitle')}</h2>
          <p className="mt-0.5 text-xs font-semibold text-text-secondary-token">
            {t('updateNotificationVersion', { version: notice.availableVersion })}
          </p>
          <p className="mt-2 text-sm text-text-secondary-token">
            {/* React text interpolation keeps manifest summaries inert. */}
            {notice.summary
              ? t('updateNotificationReleaseNotes', { summary: notice.summary })
              : t('updateNotificationGenericSummary')}
          </p>
          {actionState === 'failure' && (
            <p className="mt-2 text-xs font-medium text-status-negative">{t('updateNotificationActionFailed')}</p>
          )}
          <button
            type="button"
            data-testid="update-notification-action"
            disabled={actionState === 'loading'}
            aria-label={actionState === 'loading' ? t('updateNotificationActionInProgress') : actionLabel}
            onClick={() => void runAction()}
            className="mt-3 inline-flex min-h-9 items-center justify-center gap-2 rounded-full bg-accent-primary px-4 text-sm font-bold text-text-on-accent disabled:cursor-wait disabled:opacity-70"
          >
            {actionState === 'loading' && <Icon name={IconName.Loader} size="xs" className="animate-spin" />}
            {actionState === 'loading' ? t('updateNotificationActionInProgress') : actionLabel}
          </button>
        </div>
        <button
          type="button"
          data-testid="update-notification-dismiss"
          aria-label={t('updateNotificationDismiss')}
          onClick={onDismiss}
          className="flex size-8 shrink-0 items-center justify-center rounded-full text-text-tertiary-token hover:bg-fill focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-primary"
        >
          <Icon name={IconName.Close} size="xs" fill="currentColor" />
        </button>
      </div>
    </section>
  );
};
