import React, { FC } from 'react';

import { motion, useReducedMotion, type TargetAndTransition, type Transition } from 'framer-motion';

import { Pill } from 'components/ui/Pill';
import { bakeMotion, bakePhaseReached, BAKE_STAGGER_S, resolveTransition, type BakePhase } from 'lib/animation';

export interface OvenSceneProps {
  phase: BakePhase;
  /** The label on the dough: the name of the test network. */
  doughLabel: string;
  /** The label on the loaf. */
  loafLabel: string;
}

/**
 * Where the dough or the loaf is: `y` is the top of its 112 x 72 box in the 280 x 320 stage, and
 * `scale` is about the centre of that box.
 */
interface Place {
  y: number;
  scale: number;
}

const START: Place = { y: 214, scale: 1 };
const IN_OVEN: Place = { y: 86, scale: 0.6 };
const RISEN: Place = { y: 84, scale: 0.66 };
const SERVED: Place = { y: 206, scale: 1.2 };
const HERO: Place = { y: 146, scale: 1.5 };

const placeFor = (phase: BakePhase): Place => {
  switch (phase) {
    case 'enter':
    case 'open':
      return START;
    case 'load':
    case 'close':
      return IN_OVEN;
    case 'bake':
    case 'ding':
      return RISEN;
    case 'serve':
      return SERVED;
    case 'welcome':
      return HERO;
  }
};

const doorOpenIn = (phase: BakePhase): boolean => {
  switch (phase) {
    case 'open':
    case 'load':
    case 'ding':
    case 'serve':
    case 'welcome':
      return true;
    case 'enter':
    case 'close':
    case 'bake':
      return false;
  }
};

/** The heat in the oven: a loop while it bakes, a low rest while the door opens, else none. */
const glowFor = (phase: BakePhase): { animate: TargetAndTransition; transition: Transition } => {
  switch (phase) {
    case 'bake':
      return { animate: { opacity: [0.35, 0.85] }, transition: bakeMotion.glow };
    case 'ding':
      return { animate: { opacity: 0.25 }, transition: bakeMotion.fade };
    case 'enter':
    case 'open':
    case 'load':
    case 'close':
    case 'serve':
    case 'welcome':
      return { animate: { opacity: 0 }, transition: bakeMotion.fade };
  }
};

/** The sparkles around the loaf: the offset in its box, the size, and which of the two tones. */
const SPARKLES = [
  { left: -16, top: -10, scale: 1, light: false },
  { left: 100, top: -20, scale: 1.3, light: true },
  { left: 112, top: 40, scale: 0.8, light: false },
  { left: -24, top: 38, scale: 0.7, light: true },
  { left: 46, top: -28, scale: 0.6, light: false }
];

const STEAM_LEFTS = [104, 135, 166];

/**
 * The oven illustration of the mainnet welcome. It has no state of its own: every part reads its
 * target from `phase` (see `lib/animation/bake`). The colours of the dough and the loaf come from
 * the build's brand ramp, which does not change with the theme. The oven uses the theme's surfaces.
 *
 * The scene is decoration. Assistive technology reads the welcome text, not the scene.
 */
export const OvenScene: FC<OvenSceneProps> = ({ phase, doughLabel, loafLabel }) => {
  const reduce = useReducedMotion();
  const resolve = (transition: Transition) => resolveTransition(reduce, transition);

  const place = placeFor(phase);
  const doorOpen = doorOpenIn(phase);
  const baking = phase === 'bake' && !reduce;
  const baked = bakePhaseReached(phase, 'bake');
  const served = bakePhaseReached(phase, 'serve');
  const ovenGone = phase === 'welcome';
  const glow = glowFor(phase);

  return (
    <div
      aria-hidden="true"
      className="relative h-[320px] w-[280px] shrink-0"
      data-testid="oven-scene"
      data-phase={phase}
    >
      {/* The oven, the dough and the door shake together while the oven bakes. */}
      <motion.div
        className="absolute inset-0"
        initial={false}
        animate={baking ? { rotate: [-0.8, 0.8] } : { rotate: 0 }}
        transition={baking ? bakeMotion.wobble : resolve(bakeMotion.fade)}
        style={{ transformOrigin: '50% 65%' }}
      >
        {baking &&
          STEAM_LEFTS.map((left, index) => (
            <motion.span
              key={left}
              className="absolute top-2 size-2.5 rounded-full bg-fill-pressed"
              style={{ left }}
              initial={{ opacity: 0, y: 0, scale: 0.6 }}
              animate={{ opacity: [0, 0.9, 0], y: -24, scale: 1.2 }}
              transition={{ ...bakeMotion.steam, delay: index * BAKE_STAGGER_S }}
            />
          ))}

        {/* The oven's body and the space inside it. */}
        <motion.svg
          width="200"
          height="190"
          viewBox="0 0 200 190"
          className="absolute top-5 left-10"
          initial={false}
          animate={{ opacity: ovenGone ? 0 : 1, scale: ovenGone ? 0.9 : 1 }}
          transition={resolve(bakeMotion.fade)}
        >
          <rect x="18" y="178" width="22" height="12" rx="4" className="fill-fill-pressed" />
          <rect x="160" y="178" width="22" height="12" rx="4" className="fill-fill-pressed" />
          <rect
            x="0.75"
            y="0.75"
            width="198.5"
            height="181"
            rx="26"
            className="fill-fill stroke-hairline"
            strokeWidth="1.5"
          />
          <circle cx="30" cy="21" r="7" className="fill-fill-pressed" />
          <rect x="29" y="15" width="2" height="6" rx="1" className="fill-muted" />
          <circle cx="54" cy="21" r="7" className="fill-fill-pressed" />
          <rect x="53" y="15" width="2" height="6" rx="1" className="fill-muted" />
          <rect x="132" y="14" width="40" height="14" rx="7" className="fill-fill-pressed" />
          {/* The light is on while the oven bakes. */}
          <circle cx="178" cy="21" r="4" className={phase === 'bake' ? 'fill-primary-orange' : 'fill-fill-pressed'} />
          <rect x="22" y="46" width="156" height="112" rx="16" className="fill-pure-black/85" />
          <motion.rect
            x="22"
            y="46"
            width="156"
            height="112"
            rx="16"
            className="fill-primary-orange"
            initial={false}
            animate={reduce ? { opacity: 0 } : glow.animate}
            transition={reduce ? resolve(bakeMotion.fade) : glow.transition}
          />
          <rect x="34" y="132" width="132" height="3" rx="1.5" className="fill-pure-white/35" />
        </motion.svg>

        {/* The dough, which becomes the loaf. It is over the open door and under the closed one. */}
        <motion.div
          className="absolute left-[84px] h-[72px] w-[112px]"
          style={{ zIndex: doorOpen ? 30 : 10 }}
          initial={reduce ? false : { opacity: 0, y: START.y + 24, scale: START.scale }}
          animate={{ opacity: 1, y: place.y, scale: place.scale }}
          transition={resolve(phase === 'serve' ? bakeMotion.serve : bakeMotion.travel)}
          data-testid="oven-scene-item"
        >
          <motion.svg
            width="112"
            height="72"
            viewBox="0 0 112 72"
            className="absolute inset-0"
            initial={false}
            animate={{ opacity: baked ? 0 : 1 }}
            transition={resolve(bakeMotion.brown)}
          >
            <path
              d="M12 56C2 42 12 20 38 16C50 6 76 8 86 18C104 20 112 42 100 56C94 66 18 66 12 56Z"
              className="fill-primary-orange-lighter stroke-primary-orange-light"
              strokeWidth="2.5"
            />
            <path
              d="M34 30C40 26 46 25 52 26"
              fill="none"
              className="stroke-primary-orange-light"
              strokeWidth="2.5"
              strokeLinecap="round"
            />
            <circle cx="74" cy="34" r="2" className="fill-primary-orange-light" />
            <circle cx="64" cy="46" r="1.6" className="fill-primary-orange-light" />
            <circle cx="42" cy="44" r="1.6" className="fill-primary-orange-light" />
          </motion.svg>
          <motion.svg
            width="112"
            height="72"
            viewBox="0 0 112 72"
            className="absolute inset-0"
            initial={false}
            animate={{ opacity: baked ? 1 : 0 }}
            transition={resolve(bakeMotion.brown)}
          >
            <path
              d="M8 50C8 28 28 12 56 12C84 12 104 28 104 50C104 60 98 64 90 64H22C14 64 8 60 8 50Z"
              className="fill-primary-orange stroke-primary-orange-dark"
              strokeWidth="2.5"
            />
            <path
              d="M14 52C30 58 82 58 98 52C98 59 94 62 90 62H22C18 62 14 59 14 52Z"
              className="fill-primary-orange-dark/25"
            />
            <path
              d="M36 27L46 41M53 23L63 39M70 27L80 41"
              className="stroke-primary-orange-lighter"
              strokeWidth="4.5"
              strokeLinecap="round"
            />
            <path
              d="M22 40C24 30 32 23 40 20"
              fill="none"
              className="stroke-primary-orange-light/80"
              strokeWidth="3"
              strokeLinecap="round"
            />
          </motion.svg>

          {SPARKLES.map((sparkle, index) => (
            <motion.svg
              key={index}
              width="20"
              height="20"
              viewBox="0 0 20 20"
              className={sparkle.light ? 'absolute fill-primary-orange-light' : 'absolute fill-primary-orange'}
              style={{ left: sparkle.left, top: sparkle.top }}
              initial={false}
              animate={
                ovenGone && !reduce
                  ? { scale: [sparkle.scale, sparkle.scale * 0.6] }
                  : { scale: served ? sparkle.scale : 0 }
              }
              transition={
                ovenGone && !reduce
                  ? bakeMotion.twinkle
                  : { ...resolve(bakeMotion.sparkle), delay: reduce ? 0 : index * BAKE_STAGGER_S }
              }
            >
              <path d="M10 0C11 6 14 9 20 10C14 11 11 14 10 20C9 14 6 11 0 10C6 9 9 6 10 0Z" />
            </motion.svg>
          ))}

          {/* The labels hang under the item. Each one fades on its own. */}
          <div className="absolute top-full left-1/2 mt-2 -translate-x-1/2">
            <motion.div
              initial={false}
              animate={{ opacity: bakePhaseReached(phase, 'load') ? 0 : 1 }}
              transition={resolve(bakeMotion.fade)}
              data-testid="oven-scene-dough-label"
            >
              <Pill size="sm">{doughLabel}</Pill>
            </motion.div>
          </div>
          <div className="absolute top-full left-1/2 mt-2 -translate-x-1/2">
            <motion.div
              initial={false}
              animate={{ opacity: served ? 1 : 0 }}
              transition={resolve(bakeMotion.fade)}
              data-testid="oven-scene-loaf-label"
            >
              <Pill size="sm" tone="selected">
                {loafLabel}
              </Pill>
            </motion.div>
          </div>
        </motion.div>

        {/* The door, with its window. It swings down on its bottom edge. */}
        <motion.div
          className="absolute top-[60px] left-[56px] z-20 h-[124px] w-[168px]"
          style={{ transformOrigin: '50% 100%', transformPerspective: 800 }}
          initial={false}
          animate={{ rotateX: doorOpen ? -100 : 0, opacity: ovenGone ? 0 : 1 }}
          transition={resolve(bakeMotion.door)}
          data-testid="oven-scene-door"
          data-open={doorOpen}
        >
          <svg width="168" height="124" viewBox="0 0 168 124">
            <path
              fillRule="evenodd"
              d="M18 0H150A18 18 0 0 1 168 18V106A18 18 0 0 1 150 124H18A18 18 0 0 1 0 106V18A18 18 0 0 1 18 0ZM30 26H138A10 10 0 0 1 148 36V88A10 10 0 0 1 138 98H30A10 10 0 0 1 20 88V36A10 10 0 0 1 30 26Z"
              className="fill-fill-pressed stroke-hairline"
              strokeWidth="1.5"
            />
            <rect x="46" y="9" width="76" height="7" rx="3.5" className="fill-muted/55" />
            <path d="M36 84L68 34" className="stroke-pure-white/20" strokeWidth="5" strokeLinecap="round" />
          </svg>
        </motion.div>
      </motion.div>
    </div>
  );
};
