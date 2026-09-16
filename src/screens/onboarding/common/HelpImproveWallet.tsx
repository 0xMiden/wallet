import React, { useCallback } from 'react';

import { useTranslation } from 'react-i18next';

import { Button, ButtonVariant } from 'components/Button';
import { setTelemetrySetting } from 'lib/settings/helpers';
import { initCrashReporting } from 'lib/telemetry/crash';

export interface HelpImproveWalletScreenProps {
  onSubmit?: () => void;
}

/**
 * The first-launch consent prompt.
 *
 * Both buttons record a choice: a skip is an answer, not the absence of one, so
 * `hasTelemetryChoice()` reads true either way and the prompt does not come
 * back on the next launch. Nothing is recorded by merely rendering — consent is
 * off until the user presses something.
 */
export const HelpImproveWalletScreen: React.FC<HelpImproveWalletScreenProps> = ({ onSubmit }) => {
  const { t } = useTranslation();

  // Awaited before navigating away, on both paths: `onSubmit` routes onward,
  // which unmounts screens and can end flows, and those events are gated on a
  // consent value the background reads from the mirror. Leaving the write in
  // flight makes which value they see a race. See `setTelemetrySetting`.
  const onAccept = useCallback(async () => {
    await setTelemetrySetting(true);
    // Startup gated the reporter on a consent that was not yet given, so start
    // it here rather than leaving this whole first session unreported.
    initCrashReporting();
    onSubmit?.();
  }, [onSubmit]);

  // No teardown counterpart to the accept path's `initCrashReporting`: this
  // screen only renders before the user has ever answered, and consent defaults
  // to off, so there is nothing running here to stop. The Settings toggle, which
  // *can* be reached with sharing under way, does the tearing down.
  const onDecline = useCallback(async () => {
    await setTelemetrySetting(false);
    onSubmit?.();
  }, [onSubmit]);

  return (
    <div className="bg-app-bg h-full overflow-y-auto" data-testid="onboarding-help-improve-wallet">
      <div className="min-h-full flex flex-col items-center px-6">
        <div className="flex-1 flex flex-col items-center justify-center w-full pt-20 py-8">
          <h1 className="text-[1.75rem] font-bold font-heading text-heading-gray text-center leading-[105%] tracking-tight">
            {t('helpImproveWallet')}
          </h1>
          <p
            className="mt-4 text-sm leading-[150%] text-text-muted text-center"
            data-testid="help-improve-wallet-disclosure"
          >
            {t('helpImproveWalletDescription')}
          </p>
        </div>

        <div className="w-full flex flex-col items-center gap-3 pb-6 shrink-0">
          <Button title={t('helpImproveWalletAccept')} onClick={onAccept} data-testid="help-improve-wallet-accept" />
          <Button
            title={t('helpImproveWalletDecline')}
            variant={ButtonVariant.Secondary}
            onClick={onDecline}
            data-testid="help-improve-wallet-decline"
          />
        </div>
      </div>
    </div>
  );
};

export default HelpImproveWalletScreen;
