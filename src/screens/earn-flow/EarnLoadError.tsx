import React, { FC } from 'react';

import classNames from 'clsx';
import { useTranslation } from 'react-i18next';

import { Button, ButtonVariant } from 'components/Button';
import { Notice } from 'components/ui/Notice';
import { Spinner } from 'components/ui/Spinner';
import { type UiEvidenceInput, validateUiEvidence } from 'lib/telemetry/ui-producer-diagnostics';
import { UserErrorId } from 'lib/telemetry/user-visible-error-contract';

/**
 * A positions load that did not fully succeed. It must not read as "you have no positions": that
 * would present a network or service problem as an empty portfolio. With nothing to fall back on it
 * stands in for the content; above last-good data it marks that data as possibly incomplete. Shared
 * by every `useEarnPositions` consumer, so all of them retry the same way. The vault surfaces pass
 * `message` to say the vault could not load, which is true for a user with no positions too.
 */
export const EarnLoadError: FC<{
  onRetry: () => void;
  isRetrying?: boolean;
  className?: string;
  message?: string;
  errorId?: UserErrorId;
  errorDiagnostics?: UiEvidenceInput;
}> = ({ isRetrying = false, onRetry, className, message, errorId = 'earnPositionsLoadError', errorDiagnostics }) => {
  const { t } = useTranslation();

  return (
    <div className={classNames('flex flex-col items-center gap-4', className)}>
      {/* The shared notice, in the negative tone, rather than a page-local alert block. */}
      <Notice
        errorId={errorId}
        errorDiagnostics={validateUiEvidence(errorId, 'notice', errorDiagnostics)}
        tone="negative"
        role="alert"
        data-testid="earn-positions-load-error"
      >
        {message ?? t('earnPositionsLoadError')}
      </Notice>
      {/* The shared compact secondary button, which brings the tap haptic and the press motion
          with it. */}
      <Button
        type="button"
        data-testid="earn-positions-retry"
        variant={ButtonVariant.Secondary}
        size="sm"
        title={t('retry')}
        // `Button` fires the tap haptic itself; calling it here too would buzz twice.
        onClick={onRetry}
        disabled={isRetrying}
        aria-busy={isRetrying}
        iconLeft={isRetrying && <Spinner size="sm" />}
        className="w-auto"
      />
    </div>
  );
};
