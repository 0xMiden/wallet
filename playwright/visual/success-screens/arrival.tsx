// Five ways for the success screen's tick to arrive. In each, the token that was just sent appears
// where the tick goes and becomes it. The tick itself is the app's own (SuccessHero), so every
// option ends on the same thing. Each plays once, in about a second. 'drop' is the one chosen for the
// flow, and the default. Nothing here ships.
import React, { FC } from 'react';

import { motion, useReducedMotion } from 'framer-motion';

import { TokenLogo } from '../../../src/components/TokenLogo';
import { SuccessHero } from '../../../src/screens/generating-transaction/success/TransactionSuccessLayout';
import type { ProtoToken } from './tokens';

export type ArrivalStyle = 'pop' | 'flip' | 'drop' | 'wipe' | 'burst';

const GREEN = 'var(--status-positive, #8fb588)';
const OVERSHOOT = [0.3, 1.3, 0.5, 1] as const;

/** The token as a 64px coin, the size of the tick. */
const Coin: FC<{ token: ProtoToken }> = ({ token }) => (
  <span className="flex size-16 items-center justify-center rounded-full bg-white shadow-md">
    <span className="flex shrink-0 scale-[0.727]">
      <TokenLogo faucetId={token.id} size="xl" />
    </span>
  </span>
);

const Ring: FC<{ delay: number }> = ({ delay }) => (
  <motion.span
    aria-hidden="true"
    className="absolute inset-0 rounded-full"
    style={{ boxShadow: `inset 0 0 0 3px ${GREEN}` }}
    initial={{ scale: 0.8, opacity: 0 }}
    // Opacity starts from 0 inside the keyframes too, so nothing shows while the delay runs.
    animate={{ scale: [0.8, 0.8, 1.9], opacity: [0, 0.55, 0] }}
    transition={{ delay, duration: 0.6, times: [0, 0.04, 1], ease: [0.2, 0.7, 0.3, 1] }}
  />
);

const layer = 'absolute inset-0 flex items-center justify-center';

export const ArrivalHero: FC<{ token: ProtoToken; variant?: ArrivalStyle }> = ({ token, variant = 'drop' }) => {
  const still = useReducedMotion();
  if (still) {
    return (
      <div className="flex shrink-0 justify-center">
        <SuccessHero />
      </div>
    );
  }
  const frame = 'relative mx-auto flex size-16 shrink-0 items-center justify-center';

  if (variant === 'flip') {
    // A coin toss: it hops, turns over in the air, and lands tick side up.
    return (
      <div className={frame} style={{ perspective: 500 }}>
        <motion.div
          className="absolute inset-0"
          style={{ transformStyle: 'preserve-3d' }}
          initial={{ rotateY: 0, y: 0, scale: 0.6, opacity: 0 }}
          animate={{ rotateY: [0, 0, 540], y: [0, 0, -26, 0], scale: [0.6, 1, 1.08, 1], opacity: [0, 1, 1, 1] }}
          transition={{ duration: 1.05, times: [0, 0.22, 0.62, 1], ease: 'easeInOut' }}
        >
          <span className={layer} style={{ backfaceVisibility: 'hidden' }}>
            <Coin token={token} />
          </span>
          <span className={layer} style={{ backfaceVisibility: 'hidden', transform: 'rotateY(180deg)' }}>
            <SuccessHero />
          </span>
        </motion.div>
        <Ring delay={1} />
      </div>
    );
  }

  if (variant === 'drop') {
    // It drops in from above, squashes as it lands, and the tick springs up out of the squash.
    return (
      <div className={frame}>
        <Ring delay={0.62} />
        <motion.div
          className={layer}
          style={{ transformOrigin: '50% 100%' }}
          initial={{ scaleX: 1.25, scaleY: 0.7, opacity: 0 }}
          animate={{ scaleX: [1.25, 0.94, 1], scaleY: [0.7, 1.1, 1], opacity: [0, 1, 1] }}
          transition={{ delay: 0.56, duration: 0.42, times: [0, 0.55, 1], ease: 'easeOut' }}
        >
          <SuccessHero />
        </motion.div>
        <motion.span
          aria-hidden="true"
          className={layer}
          style={{ transformOrigin: '50% 100%' }}
          initial={{ y: -120, opacity: 0, scaleX: 1, scaleY: 1 }}
          animate={{ y: [-120, 0, 0, 0], opacity: [0, 1, 1, 0], scaleX: [1, 1, 1.25, 1.25], scaleY: [1, 1, 0.7, 0.7] }}
          transition={{ duration: 0.62, times: [0, 0.7, 0.9, 1], ease: [0.5, 0, 0.9, 0.6] }}
        >
          <Coin token={token} />
        </motion.span>
      </div>
    );
  }

  if (variant === 'wipe') {
    // The calm one: the coin settles in, then green spreads over it from the centre.
    return (
      <div className={frame}>
        <motion.span
          aria-hidden="true"
          className={layer}
          initial={{ scale: 0.8, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          transition={{ duration: 0.3, ease: 'easeOut' }}
        >
          <Coin token={token} />
        </motion.span>
        <motion.div
          className={layer}
          initial={{ clipPath: 'circle(0% at 50% 50%)' }}
          animate={{ clipPath: 'circle(75% at 50% 50%)' }}
          transition={{ delay: 0.5, duration: 0.5, ease: [0.4, 0, 0.2, 1] }}
        >
          <SuccessHero />
        </motion.div>
      </div>
    );
  }

  // pop, and burst (pop with eight small dots thrown outward as it turns).
  return (
    <div className={frame}>
      <Ring delay={0.68} />
      {variant === 'burst' &&
        Array.from({ length: 8 }, (_, index) => {
          const angle = (index / 8) * Math.PI * 2;
          return (
            <motion.span
              key={index}
              aria-hidden="true"
              className="absolute left-1/2 top-1/2 -ml-1 -mt-1 size-2 rounded-full"
              style={{ background: index % 2 ? GREEN : 'var(--accent-primary)' }}
              initial={{ x: 0, y: 0, opacity: 0, scale: 1 }}
              animate={{ x: [0, 0, Math.cos(angle) * 58], y: [0, 0, Math.sin(angle) * 58], opacity: [0, 1, 0], scale: [1, 1, 0.4] }}
              transition={{ delay: 0.66, duration: 0.6, times: [0, 0.04, 1], ease: [0.1, 0.7, 0.3, 1] }}
            />
          );
        })}
      <motion.div
        className={layer}
        initial={{ scale: 0.3, opacity: 0 }}
        animate={{ scale: [0.3, 1.16, 1], opacity: [0, 1, 1] }}
        transition={{ delay: 0.62, duration: 0.5, times: [0, 0.6, 1], ease: OVERSHOOT }}
      >
        <SuccessHero />
      </motion.div>
      <motion.span
        aria-hidden="true"
        className={layer}
        initial={{ scale: 0.5, opacity: 0 }}
        animate={{ scale: [0.5, 1, 1, 1.32, 0.4], opacity: [0, 1, 1, 1, 0] }}
        transition={{ duration: 0.86, times: [0, 0.26, 0.52, 0.76, 1], ease: 'easeInOut' }}
      >
        <Coin token={token} />
      </motion.span>
    </div>
  );
};
