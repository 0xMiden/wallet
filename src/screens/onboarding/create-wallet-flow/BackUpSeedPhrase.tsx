import React, { useCallback, useEffect, useState } from 'react';

import classNames from 'clsx';
import { useTranslation } from 'react-i18next';

import { IconName } from 'app/icons/v2';
import { Button, ButtonVariant } from 'components/Button';
import { AnimatedCopyIcon, CopyLabel } from 'components/ui/CopyFeedback';
import { Pill } from 'components/ui/Pill';
import { COPY_FEEDBACK_MS } from 'lib/animation/copy';
import { useScreenshotGuard } from 'lib/mobile/screenshot-guard';

import { OnboardingStepLayout } from '../common/OnboardingStepLayout';

export interface BackUpSeedPhraseScreenProps {
  seedPhrase: string[];
  onSubmit?: () => void;
  'data-testid'?: string;
}

export const BackUpSeedPhraseScreen: React.FC<BackUpSeedPhraseScreenProps> = ({
  seedPhrase,
  onSubmit,
  'data-testid': dataTestId
}) => {
  const { t } = useTranslation();
  const [isWordsVisible, setIsWordsVisible] = useState(false);
  const [isCopied, setIsCopied] = useState(false);

  // Block screenshots/recordings while the backup phrase is on screen (#417).
  // The words are only rendered once the guard reports the screen is protected.
  const isGuardReady = useScreenshotGuard();

  const onCopyToClipboard = useCallback(() => {
    navigator.clipboard.writeText(seedPhrase.join(' '));
    setIsCopied(true);
    setTimeout(() => setIsCopied(false), COPY_FEEDBACK_MS);
  }, [seedPhrase]);

  const onWordsVisibilityToggle = useCallback(() => {
    setIsWordsVisible(prev => !prev);
  }, []);

  useEffect(() => {
    document.addEventListener('copy', event => {
      const selectedText = window.getSelection()?.toString();
      const formattedText = selectedText?.replace(/[^a-zA-Z\s]/g, '').replace(/\s+/g, ' ');
      event.clipboardData?.setData('text/plain', formattedText || '');
      event.preventDefault(); // Prevent the default copy action
    });

    return () => {
      document.removeEventListener('copy', () => {});
    };
  }, []);

  return (
    <OnboardingStepLayout
      data-testid={dataTestId}
      title={t('backUpYourWallet')}
      description={
        <span className="flex flex-col gap-1">
          <span>{t('backUpWalletInstructions')}</span>
          <span className="font-bold text-ink">{t('doNotShareWithAnywone')}</span>
          <span>{t('seedPhraseRecoveryCaption')}</span>
        </span>
      }
      footer={<Button data-testid="backup-seed-continue" title={t('continue')} onClick={onSubmit} />}
    >
      <div className="flex flex-col gap-3">
        <article className="grid grid-cols-3 gap-2">
          {isGuardReady &&
            seedPhrase.map((word, index) => (
              <Pill
                className="w-full justify-start"
                key={`seed-word-${index}`}
                data-testid={`seed-word-${index}`}
                tone="word"
              >
                <span
                  className={classNames(
                    'flex w-full min-w-0 gap-1',
                    'transition duration-300 ease-in-out motion-reduce:transition-none',
                    isWordsVisible ? 'blur-none' : 'blur-sm'
                  )}
                >
                  <span className="pointer-events-none text-muted tabular-nums select-none">{`${index + 1}.`}</span>
                  <span className="truncate">{word}</span>
                </span>
              </Pill>
            ))}
        </article>

        <div className="flex gap-2.5">
          <Button
            size="sm"
            className="flex-1"
            variant={ButtonVariant.Secondary}
            title={t(isWordsVisible ? 'hide' : 'show')}
            iconLeft={isWordsVisible ? IconName.EyeOff : IconName.Eye}
            onClick={onWordsVisibilityToggle}
          />
          <Button
            size="sm"
            className="flex-1"
            variant={ButtonVariant.Secondary}
            title={t('copyToClipboard')}
            onClick={onCopyToClipboard}
          >
            <AnimatedCopyIcon copied={isCopied} size="sm" />
            <CopyLabel copied={isCopied} copiedLabel={t('copied')}>
              {t('copyToClipboard')}
            </CopyLabel>
          </Button>
        </div>
      </div>
    </OnboardingStepLayout>
  );
};
