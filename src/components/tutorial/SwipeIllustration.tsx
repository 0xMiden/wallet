import React, { FC } from 'react';

import { motion, useReducedMotion } from 'framer-motion';
import { useTranslation } from 'react-i18next';

/**
 * The swipe-teaching picture: a one-finger pointing hand gliding right → left
 * past fading chevrons, with a touch ripple at the fingertip. Rides
 * `currentColor` like the notes illustration so it theme-flips for free.
 * Under reduced motion the hand rests mid-glide with static chevrons.
 */
export const SwipeIllustration: FC = () => {
  const { t } = useTranslation();
  const reduce = useReducedMotion();

  return (
    <svg
      viewBox="0 0 280 96"
      role="img"
      aria-label={t('tourSwipeIllustrationAlt')}
      className="w-full text-heading-gray"
    >
      {/* Direction chevrons pointing left */}
      <g stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" fill="none">
        {reduce ? (
          <>
            <path d="M76 32 L62 46 L76 60" opacity="0.7" />
            <path d="M98 32 L84 46 L98 60" opacity="0.4" />
          </>
        ) : (
          <>
            <motion.path
              d="M76 32 L62 46 L76 60"
              animate={{ opacity: [0.15, 0.9, 0.15] }}
              transition={{ duration: 1.8, repeat: Infinity, ease: 'easeInOut', delay: 0.25 }}
            />
            <motion.path
              d="M98 32 L84 46 L98 60"
              animate={{ opacity: [0.15, 0.9, 0.15] }}
              transition={{ duration: 1.8, repeat: Infinity, ease: 'easeInOut' }}
            />
          </>
        )}
      </g>

      {/* Pointing hand, gliding right → left */}
      <g transform="translate(172,52)">
        {reduce ? (
          <HandShape />
        ) : (
          <motion.g
            initial={{ x: 46, opacity: 0 }}
            animate={{ x: [46, 20, -46, -54], opacity: [0, 1, 1, 0] }}
            transition={{
              duration: 1.8,
              times: [0, 0.2, 0.85, 1],
              ease: 'easeInOut',
              repeat: Infinity,
              repeatDelay: 0.5
            }}
          >
            <HandShape />
          </motion.g>
        )}
      </g>
    </svg>
  );
};

/**
 * Classic outline pointer hand: index finger raised, three curled fingers
 * (the short interior slits are the knuckle separators), thumb bump on the
 * left. Surface-filled so it occludes the chevrons while gliding over them.
 */
const HandShape: FC = () => (
  <g transform="translate(-28,-32)" strokeLinecap="round" strokeLinejoin="round">
    {/* Touch ripple at the fingertip */}
    <circle cx="17.5" cy="8" r="12" fill="none" stroke="currentColor" strokeWidth="2.5" opacity="0.35" />
    {/* Hand silhouette */}
    <path
      d="M11 36 V10 A6.5 6.5 0 0 1 24 10 V25 Q30 20 48 28 Q54 32 54 44 V52 Q54 66 40 66 H27 Q16 66 13 56 Q6 52 4 46 Q2 38 11 36 Z"
      className="fill-surface-solid"
      stroke="currentColor"
      strokeWidth="4"
    />
    {/* Curled-finger knuckle slits */}
    <path d="M31 24 V36 M39 25 V37 M47 28 V39" fill="none" stroke="currentColor" strokeWidth="4" />
  </g>
);

export default SwipeIllustration;
