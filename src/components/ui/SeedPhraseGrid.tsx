import React from 'react';

import { useTranslation } from 'react-i18next';

import { Icon, IconName } from 'app/icons/v2';
import { Hero } from 'components/ui/Hero';
import { cn } from 'lib/ui/util';

const WORD_COUNT = 12;

export interface SeedPhraseGridProps {
  /** The words, in order. */
  words: string[];
  /** Layout only (margins). */
  className?: string;
  'data-testid'?: string;
}

/**
 * The recovery phrase itself: a `fill` card at the group radius holding the words in three
 * numbered columns. The number is part of the phrase — it is how the user checks they wrote it
 * down in order — so every screen that shows the words shows them the same way.
 */
export const SeedPhraseGrid: React.FC<SeedPhraseGridProps> = ({ words, className, 'data-testid': dataTestId }) => (
  <div data-testid={dataTestId} className={cn('rounded-2xl bg-fill p-5', className)}>
    <div className="grid grid-cols-3 gap-x-4 gap-y-5">
      {words.map((word, idx) => (
        <div key={idx} className="flex min-w-0 items-center gap-2">
          <span className="w-5 text-right text-caption text-muted">{idx + 1}.</span>
          <span data-testid={`seed-word-${idx}`} className="text-value text-ink">
            {word}
          </span>
        </div>
      ))}
    </div>
  </div>
);

export interface SeedPhrasePlaceholderProps {
  /** Layout only (margins). */
  className?: string;
}

/**
 * A blurred stand-in for the grid above: the shape of the phrase, none of its words. Drawn on the
 * warning step, before the user has said they are somewhere private.
 */
export const SeedPhrasePlaceholder: React.FC<SeedPhrasePlaceholderProps> = ({ className }) => (
  <div aria-hidden="true" className={cn('rounded-2xl bg-fill px-6 py-8', className)}>
    <div className="grid grid-cols-2 gap-x-6 gap-y-5">
      {Array.from({ length: WORD_COUNT }).map((_, i) => (
        <div key={i} className="h-1.5 w-full rounded-full bg-fill-pressed" />
      ))}
    </div>
  </div>
);

export interface SeedPhrasePrivacyHeroProps {
  /** Layout only (margins). */
  className?: string;
}

/**
 * The warning every recovery-phrase screen opens on: "view this somewhere private", under the
 * shared outcome hero's 64px status circle.
 */
export const SeedPhrasePrivacyHero: React.FC<SeedPhrasePrivacyHeroProps> = ({ className }) => {
  const { t } = useTranslation();

  return (
    <Hero
      className={className}
      visual={
        <div className="flex size-16 items-center justify-center rounded-full bg-accent-primary">
          <Icon name={IconName.EyeOff} size="md" fill="white" />
        </div>
      }
      name={t('viewThisInPrivatePlace')}
      subtitle={t('anyoneWithRecoveryPhrase')}
    />
  );
};
