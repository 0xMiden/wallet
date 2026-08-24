import React, { FC } from 'react';

import { motion, useReducedMotion } from 'framer-motion';
import { useTranslation } from 'react-i18next';

/**
 * The notes-explainer picture: Alice (phone in hand) sends a "$10 MIDEN" note
 * that flies a parabolic arc to Bob, who deposits it into his account — the
 * cash-into-a-bank metaphor for how Miden accounts communicate asset spends
 * and receives.
 *
 * Line art rides `currentColor` (inherits `text-heading-gray` from the card)
 * so it theme-flips for free; only the note itself is accent-colored. The
 * flight is a keyframe tween (springs can't follow an arc); under reduced
 * motion the note rests at the arc's peak on the dashed guide instead.
 */
export const NotesIllustration: FC = () => {
  const { t } = useTranslation();
  const reduce = useReducedMotion();

  return (
    <svg
      viewBox="0 0 280 132"
      role="img"
      aria-label={t('tourNotesIllustrationAlt')}
      className="w-full text-heading-gray"
    >
      {/* Dashed arc guide from Alice's phone to Bob's account slot */}
      <path d="M78 50 Q157 -10 236 62" fill="none" stroke="currentColor" strokeDasharray="4 6" opacity="0.35" />

      {/* Alice, phone raised toward the arc */}
      <g stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" fill="none" transform="translate(34,32)">
        <circle cx="0" cy="0" r="9" />
        <path d="M0 9 V38" />
        <path d="M0 38 L-9 58 M0 38 L9 58" />
        <path d="M0 18 L15 26" />
        <rect x="12" y="14" width="9" height="15" rx="2" transform="rotate(12 16 21)" />
      </g>

      {/* Bob (mirrored), hand out to catch the note */}
      <g
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
        fill="none"
        transform="translate(200,32) scale(-1 1)"
      >
        <circle cx="0" cy="0" r="9" />
        <path d="M0 9 V38" />
        <path d="M0 38 L-9 58 M0 38 L9 58" />
        <path d="M0 18 L15 26" />
        <rect x="12" y="14" width="9" height="15" rx="2" transform="rotate(12 16 21)" />
      </g>

      {/* Bob's account: a bank box with a deposit slot */}
      <g stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" fill="none">
        <path d="M234 57 H256" strokeWidth="3.5" />
        <rect x="222" y="62" width="46" height="30" rx="4" />
      </g>

      <text x="34" y="106" textAnchor="middle" fontSize="11" fontWeight="600" className="fill-current">
        {t('tourIllustrationAlice')}
      </text>
      <text x="34" y="119" textAnchor="middle" fontSize="9" opacity="0.65" className="fill-current">
        {t('send')}
      </text>
      <text x="200" y="106" textAnchor="middle" fontSize="11" fontWeight="600" className="fill-current">
        {t('tourIllustrationBob')}
      </text>
      <text x="200" y="119" textAnchor="middle" fontSize="9" opacity="0.65" className="fill-current">
        {t('receive')}
      </text>

      {/* The flying note: hand-off → arc peak → catch → deposit into the slot */}
      <g transform="translate(56,44)">
        {reduce ? (
          <NoteShape x={60} y={-46} />
        ) : (
          <motion.g
            initial={{ x: 0, y: 0, opacity: 0, rotate: -8 }}
            animate={{
              x: [0, 60, 120, 158],
              y: [0, -46, 0, 16],
              opacity: [0, 1, 1, 0],
              rotate: [-8, 0, 8, 8]
            }}
            transition={{
              duration: 3,
              times: [0, 0.4, 0.75, 1],
              ease: 'easeInOut',
              repeat: Infinity,
              repeatDelay: 1.2,
              delay: 0.4
            }}
          >
            <NoteShape />
          </motion.g>
        )}
      </g>
    </svg>
  );
};

const NoteShape: FC<{ x?: number; y?: number }> = ({ x = 0, y = 0 }) => {
  const { t } = useTranslation();
  return (
    <g transform={`translate(${x},${y})`} className="text-accent-primary">
      <rect width="44" height="18" rx="4" fill="currentColor" />
      {/* Fixed white on the accent fill — legible in both themes, so no flip. */}
      <text x="22" y="12.5" textAnchor="middle" fontSize="8" fontWeight="700" fill="#FFFFFF">
        {t('tourNoteLabel')}
      </text>
    </g>
  );
};

export default NotesIllustration;
