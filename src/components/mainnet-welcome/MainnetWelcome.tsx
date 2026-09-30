import React, { FC, KeyboardEvent, useCallback, useEffect, useId, useRef, useState } from 'react';

import { motion, useReducedMotion } from 'framer-motion';
import { useTranslation } from 'react-i18next';

import { Button } from 'components/Button';
import { BAKE_PHASE_MS, bakeMotion, nextBakePhase, presets, resolveTransition, type BakePhase } from 'lib/animation';
import { getTestNetworkNameKey } from 'lib/miden-chain/effective-endpoints';
import { hapticSuccess } from 'lib/mobile/haptics';
import { useHideNavbarWhileOpen } from 'lib/mobile/useHideNavbarWhileOpen';
import { useMobileBackHandler } from 'lib/mobile/useMobileBackHandler';
import Portal from 'lib/ui/Portal';

import { OvenScene } from './OvenScene';

export interface MainnetWelcomeProps {
  open: boolean;
  /** The user tapped Continue on the welcome screen. The caller closes the screen. */
  onContinue: () => void;
}

/**
 * The full-screen welcome after an accepted mainnet access code. An oven bakes the test network's
 * dough into the "Mainnet" loaf, then the welcome text and the Continue button come in.
 *
 * The caller owns `open`. Each time the screen opens, the sequence starts from its first phase.
 */
export const MainnetWelcome: FC<MainnetWelcomeProps> = ({ open, onContinue }) => {
  if (!open) return null;
  return <MainnetWelcomeScreen onContinue={onContinue} />;
};

const MainnetWelcomeScreen: FC<Pick<MainnetWelcomeProps, 'onContinue'>> = ({ onContinue }) => {
  const { t } = useTranslation();
  const reduce = useReducedMotion();
  const titleId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const continueRef = useRef<HTMLButtonElement>(null);
  // Under reduced motion there is no sequence: the screen opens on its last phase.
  const [phase, setPhase] = useState<BakePhase>(reduce ? 'welcome' : 'enter');
  const welcome = phase === 'welcome';

  useHideNavbarWhileOpen(true);

  // One timer for each phase. `welcome` has none: it stays until the user continues.
  useEffect(() => {
    if (phase === 'welcome') return;
    const timer = window.setTimeout(() => setPhase(nextBakePhase(phase)), BAKE_PHASE_MS[phase]);
    return () => window.clearTimeout(timer);
  }, [phase]);

  // The loaf comes out: one success haptic.
  useEffect(() => {
    if (phase === 'serve') hapticSuccess();
  }, [phase]);

  // Focus starts on the screen, and moves to Continue when the button can be used.
  useEffect(() => {
    const target = welcome ? continueRef.current : dialogRef.current;
    target?.focus();
  }, [welcome]);

  // Back and Escape do the same thing: skip the sequence, or leave the welcome screen.
  const dismiss = useCallback(() => {
    if (welcome) {
      onContinue();
      return;
    }
    setPhase('welcome');
  }, [welcome, onContinue]);

  useMobileBackHandler(
    () => {
      dismiss();
      return true;
    },
    [dismiss],
    { overlay: true }
  );

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'Escape') return;
    event.stopPropagation();
    dismiss();
  };

  const reveal = {
    initial: false,
    animate: { opacity: welcome ? 1 : 0, y: welcome ? 0 : 12 },
    transition: resolveTransition(reduce, bakeMotion.reveal)
  };

  return (
    <Portal>
      <motion.div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onKeyDown={onKeyDown}
        className="fixed inset-0 z-[70] flex flex-col bg-page pt-[env(safe-area-inset-top)] outline-none"
        initial={reduce ? false : presets.fade.initial}
        animate={presets.fade.animate}
        transition={resolveTransition(reduce, presets.fade.transition)}
        data-testid="mainnet-welcome"
        data-phase={phase}
      >
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-6 px-4">
          <OvenScene phase={phase} doughLabel={t(getTestNetworkNameKey() ?? 'testnet')} loafLabel={t('mainnet')} />
          <motion.div className="flex flex-col items-center gap-2 text-center" {...reveal}>
            <h2 id={titleId} className="text-title-tab text-ink">
              {t('mainnetWelcomeTitle')}
            </h2>
            <p className="text-body text-muted">{t('mainnetWelcomeBody')}</p>
          </motion.div>
        </div>

        {/* The shared Button fires its own tap haptic. */}
        <motion.div
          className="flex shrink-0 justify-center px-4 pt-4 pb-[max(1rem,env(safe-area-inset-bottom))]"
          {...reveal}
        >
          <Button
            ref={continueRef}
            title={t('continue')}
            onClick={onContinue}
            disabled={!welcome}
            className="w-full"
            data-testid="mainnet-welcome-continue"
          />
        </motion.div>

        {/* While the sequence plays, a tap anywhere skips it. */}
        {!welcome && (
          <button
            type="button"
            aria-label={t('skip')}
            onClick={() => setPhase('welcome')}
            className="absolute inset-0 cursor-default"
            data-testid="mainnet-welcome-skip"
          />
        )}
      </motion.div>
    </Portal>
  );
};
