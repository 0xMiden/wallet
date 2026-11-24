import React, { FC } from 'react';

import { useTranslation } from 'react-i18next';

import { Icon, IconName } from 'app/icons/v2';
import { Notice, NoticeProps } from 'components/ui/Notice';
import { getCurrentLocale } from 'lib/i18n/core';
import { formatHoldCountdown, formatHoldDeadline, holdSecondsLeft } from 'lib/i18n/hold-deadline';
import { useUserVisibleError } from 'lib/telemetry/use-user-visible-error';
import { useDeadlineNow } from 'lib/ui/deadline-ticker';

interface GuardianHoldNoticeProps {
  /** From `useGuardianHoldUntil`, or the row's reading of the same rule. */
  clearsAtSec: number;
  variant?: NoticeProps['variant'];
  className?: string;
}

/**
 * Why Retry is off and when it comes back (#2060). The screens around it are large, so the ticking lives here and they
 * learn only the hold's end. The wall-clock deadline is the announced line; the countdown sits outside the status role.
 * A disabled Retry never reaches the refusal `guardian_hold` counts, so this reports its own showing instead.
 */
export const GuardianHoldNotice: FC<GuardianHoldNoticeProps> = ({ clearsAtSec, variant, className }) => {
  const { t } = useTranslation();
  const nowMs = useDeadlineNow(clearsAtSec * 1000);
  useUserVisibleError('guardianHoldNotice', 'notice');
  const secondsLeft = holdSecondsLeft(clearsAtSec, nowMs);
  if (secondsLeft <= 0) return null;

  return (
    <Notice
      role="status"
      tone="caution"
      variant={variant}
      className={className}
      icon={<Icon name={IconName.Hourglass} size="sm" fill="currentColor" />}
      title={t('guardianHoldNotice', { time: formatHoldDeadline(clearsAtSec, { locale: getCurrentLocale() }) })}
      trailing={
        <time
          dateTime={`PT${secondsLeft}S`}
          className="shrink-0 text-label tabular-nums text-pending-tint-ink"
          data-testid="guardian-hold-countdown"
        >
          {formatHoldCountdown(secondsLeft)}
        </time>
      }
      data-testid="guardian-hold-notice"
    />
  );
};
