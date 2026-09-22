import React, { useCallback, useEffect, useState } from 'react';

import classNames from 'clsx';
import { useTranslation } from 'react-i18next';

import { IconName } from 'app/icons/v2';
import { Button, ButtonVariant } from 'components/Button';
import { AnimatedCopyIcon } from 'components/ui/AnimatedCopyIcon';
import { CopyLabel } from 'components/ui/CopyLabel';
import { Pill } from 'components/ui/Pill';
import { useScreenshotGuard } from 'lib/mobile/screenshot-guard';
import { useClipboardCopy } from 'lib/ui/useClipboardCopy';

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
  // The shared implementation, not a third one: it writes through @capacitor/clipboard (one call for
  // every surface, native-backed on mobile), flips `copied` only once the write RESOLVES,
  // and owns the timer it arms. The local version wrote without awaiting and reported success
  // unconditionally - on the seed phrase, where a silent failure costs the most - and armed a
  // timeout it never cleared, so tapping Continue inside the window left it firing into a dead tree.
  const { copied: isCopied, copy: onCopyToClipboard } = useClipboardCopy(seedPhrase.join(' '));

  // Block screenshots/recordings while the backup phrase is on screen (#417).
  // The words are only rendered once the guard reports the screen is protected.
  const isGuardReady = useScreenshotGuard();

  const onWordsVisibilityToggle = useCallback(() => {
    setIsWordsVisible(prev => !prev);
  }, []);

  // The handler must be the SAME reference on the way out: the cleanup used to pass a freshly
  // allocated arrow, which matches nothing, so this listener stayed on `document` for the life of
  // the realm and one more was added per mount. Since it rewrites the clipboard payload to letters
  // and spaces and calls preventDefault(), a leaked copy of it silently mangled every later
  // select-and-copy in the app - an address or a transaction id included.
  useEffect(() => {
    const onDocumentCopy = (event: ClipboardEvent) => {
      const selectedText = window.getSelection()?.toString();
      const formattedText = selectedText?.replace(/[^a-zA-Z\s]/g, '').replace(/\s+/g, ' ');
      event.clipboardData?.setData('text/plain', formattedText || '');
      event.preventDefault(); // Prevent the default copy action
    };

    document.addEventListener('copy', onDocumentCopy);
    return () => document.removeEventListener('copy', onDocumentCopy);
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
      footer={
        <Button className="max-w-none" data-testid="backup-seed-continue" title={t('continue')} onClick={onSubmit} />
      }
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
            onClick={() => void onCopyToClipboard()}
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
