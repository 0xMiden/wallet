import React, { useCallback } from 'react';

import { useTranslation } from 'react-i18next';

import { Icon, IconName } from 'app/icons/v2';
import { Button, ButtonVariant } from 'components/Button';
import { FactRow, IconCircle } from 'components/ui/FactRow';
import { Hero } from 'components/ui/Hero';
import { ListGroup } from 'components/ui/ListGroup';
import { setTelemetrySetting } from 'lib/settings/helpers';

export interface HelpImproveWalletScreenProps {
  onSubmit?: () => void;
}

/**
 * The first-launch consent prompt.
 *
 * Both buttons record a choice: a skip is an answer, not the absence of one, so
 * `hasTelemetryChoice()` reads true either way and the prompt does not come
 * back on the next launch. Usage sharing stays off until the user accepts;
 * crash reporting starts at app launch independently of this choice.
 */
export const HelpImproveWalletScreen: React.FC<HelpImproveWalletScreenProps> = ({ onSubmit }) => {
  const { t } = useTranslation();

  // Awaited before navigating away, on both paths: `onSubmit` routes onward,
  // which unmounts screens and can end flows, and those events are gated on a
  // consent value the background reads from the mirror. Leaving the write in
  // flight makes which value they see a race. See `setTelemetrySetting`.
  const onAccept = useCallback(async () => {
    await setTelemetrySetting(true);
    onSubmit?.();
  }, [onSubmit]);

  const onDecline = useCallback(async () => {
    await setTelemetrySetting(false);
    onSubmit?.();
  }, [onSubmit]);

  return (
    <div className="bg-app-bg h-full overflow-y-auto" data-testid="onboarding-help-improve-wallet">
      <div className="min-h-full flex flex-col items-center px-6">
        <div className="flex-1 flex flex-col items-center justify-center w-full gap-5 pt-20 py-8">
          <Hero
            nameAs="h1"
            nameSize="lg"
            visual={
              <span className="flex size-16 items-center justify-center rounded-full bg-accent-tint text-accent-tint-ink">
                <Icon name={IconName.Activity} size="md" fill="currentColor" aria-hidden="true" />
              </span>
            }
            name={t('helpImproveWallet')}
            subtitle={t('helpImproveWalletSubtitle')}
          />
          {/* The full consent disclosure, grouped: what is shared, what never is, and no tracking. */}
          <div className="flex w-full flex-col gap-4" data-testid="help-improve-wallet-disclosure">
            <ListGroup surface="plain" insetHairlines>
              <FactRow
                leading={
                  <IconCircle>
                    <Icon name={IconName.Hammer} size="xs" fill="currentColor" />
                  </IconCircle>
                }
                title={t('helpImproveWalletSharedTitle')}
                description={t('helpImproveWalletSharedDescription')}
              />
              <FactRow
                leading={
                  <IconCircle>
                    <Icon name={IconName.Lock} size="xs" fill="currentColor" />
                  </IconCircle>
                }
                title={t('helpImproveWalletPrivateTitle')}
                description={t('helpImproveWalletPrivateDescription')}
              />
              <FactRow
                leading={
                  <IconCircle>
                    <Icon name={IconName.EyeOff} size="xs" fill="currentColor" />
                  </IconCircle>
                }
                title={t('helpImproveWalletNoTrackingTitle')}
                description={t('helpImproveWalletNoTrackingDescription')}
              />
            </ListGroup>
            <p className="text-center text-body-sm text-muted" data-testid="help-improve-wallet-crash-reports">
              {t('helpImproveWalletCrashReports')}
            </p>
            <p className="text-center text-body-sm text-muted">{t('helpImproveWalletChangeAnyTime')}</p>
          </div>
        </div>

        <div className="w-full flex flex-col items-center gap-3 pb-[calc(1.5rem+var(--wallet-control-safe-bottom,0px))] shrink-0">
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
