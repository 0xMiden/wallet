import React, { useId } from 'react';

export type BreadMascotMood = 'idle' | 'thinking' | 'clarifying' | 'working' | 'happy' | 'oops';

const SIZE_CLASSES: Record<'sm' | 'md' | 'lg', string> = {
  sm: 'h-9 w-9',
  md: 'h-12 w-12',
  lg: 'h-14 w-14'
};

export function BreadMascot({
  mood = 'idle',
  size = 'md',
  className = ''
}: {
  mood?: BreadMascotMood;
  size?: 'sm' | 'md' | 'lg';
  className?: string;
}): React.ReactElement {
  const uid = useId().replace(/:/g, '');
  const animated = mood === 'thinking' || mood === 'working' || mood === 'happy';
  const bodyAnim = animated ? `animation: bread-bob-${uid} 2.4s ease-in-out infinite;` : '';
  const sparkleAnim = animated ? `animation: bread-sparkle-${uid} 1.6s ease-in-out infinite;` : 'opacity: 0;';
  const mascotStyles = `
    @keyframes bread-bob-${uid} {
      0%, 100% { transform: translateY(0px) rotate(0deg); }
      50% { transform: translateY(-2.5px) rotate(-1.5deg); }
    }
    @keyframes bread-blink-${uid} {
      0%, 92%, 100% { transform: scaleY(1); }
      96% { transform: scaleY(0.12); }
    }
    @keyframes bread-sparkle-${uid} {
      0%, 100% { opacity: 0.35; transform: scale(0.82) translateY(0px); }
      50% { opacity: 1; transform: scale(1.12) translateY(-1.5px); }
    }
    .bread-body-${uid} {
      transform-origin: 32px 36px;
      ${bodyAnim}
    }
    .bread-eyes-${uid} {
      transform-origin: 32px 34px;
      animation: bread-blink-${uid} 4.2s ease-in-out infinite;
    }
    .bread-sparkle-${uid} {
      transform-origin: 51px 13px;
      ${sparkleAnim}
    }
    @media (prefers-reduced-motion: reduce) {
      .bread-body-${uid}, .bread-eyes-${uid}, .bread-sparkle-${uid} {
        animation: none !important;
      }
    }
  `;

  return (
    <svg
      viewBox="0 0 64 64"
      aria-hidden="true"
      data-testid="bread-mascot"
      data-mood={mood}
      className={`shrink-0 select-none ${SIZE_CLASSES[size]} ${className}`}
    >
      <style>{mascotStyles}</style>
      <defs>
        <radialGradient id={`glow-${uid}`} cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="#FB923C" stopOpacity="0.34" />
          <stop offset="100%" stopColor="#FB923C" stopOpacity="0" />
        </radialGradient>
        <linearGradient id={`crust-${uid}`} x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="#E08B3C" />
          <stop offset="100%" stopColor="#A9581A" />
        </linearGradient>
        <linearGradient id={`crumb-${uid}`} x1="0%" y1="0%" x2="0%" y2="100%">
          <stop offset="0%" stopColor="#FFF0CF" />
          <stop offset="100%" stopColor="#FAD59B" />
        </linearGradient>
      </defs>

      <circle cx="32" cy="34" r="29" fill={`url(#glow-${uid})`} />

      <g className={`bread-body-${uid}`}>
        {/* Toasted crust silhouette */}
        <path
          d="M17 17 C17 11, 47 11, 47 17 C53 19, 55 26, 51 31 L50 47 C50 51.5, 46.5 54, 42 54 L22 54 C17.5 54, 14 51.5, 14 47 L13 31 C9 26, 11 19, 17 17 Z"
          fill={`url(#crust-${uid})`}
          stroke="#7C3B0C"
          strokeWidth="2"
          strokeLinejoin="round"
        />

        {/* Top crust highlight */}
        <path
          d="M20 15.5 C26 13.8, 38 13.8, 44 15.5"
          fill="none"
          stroke="#FDBA74"
          strokeWidth="1.6"
          strokeLinecap="round"
          opacity="0.7"
        />

        {/* Soft warm inner crumb */}
        <path
          d="M20 21.5 C20 18, 44 18, 44 21.5 C47.5 22.8, 48.5 27, 45.8 30 L45 45.5 C45 48, 43.2 49.5, 40.5 49.5 L23.5 49.5 C20.8 49.5, 19 48, 19 45.5 L18.2 30 C15.5 27, 16.5 22.8, 20 21.5 Z"
          fill={`url(#crumb-${uid})`}
        />

        {/* Subtle crumb freckles */}
        <circle cx="23" cy="24.5" r="1" fill="#E6AD63" opacity="0.5" />
        <circle cx="41.5" cy="44" r="1.1" fill="#E6AD63" opacity="0.45" />
        <circle cx="22.5" cy="43.5" r="0.9" fill="#E6AD63" opacity="0.4" />

        {/* Rosy cheeks */}
        <ellipse cx="22.5" cy="37.2" rx="2.8" ry="1.6" fill="#FB7185" opacity="0.45" />
        <ellipse cx="41.5" cy="37.2" rx="2.8" ry="1.6" fill="#FB7185" opacity="0.45" />

        {/* Brows */}
        {mood === 'clarifying' && (
          <>
            <path
              d="M23 28.5 Q25.5 26.8 28 28.2"
              fill="none"
              stroke="#6B3710"
              strokeWidth="1.6"
              strokeLinecap="round"
            />
            <path d="M36 27 Q39 25 41.5 26.8" fill="none" stroke="#6B3710" strokeWidth="1.6" strokeLinecap="round" />
          </>
        )}
        {mood === 'oops' && (
          <>
            <path d="M23 29 Q25.5 27.5 28 29.8" fill="none" stroke="#6B3710" strokeWidth="1.6" strokeLinecap="round" />
            <path d="M36 29.8 Q38.5 27.5 41 29" fill="none" stroke="#6B3710" strokeWidth="1.6" strokeLinecap="round" />
          </>
        )}

        {/* Blinking eyes */}
        <g className={`bread-eyes-${uid}`}>
          {mood === 'happy' ? (
            <>
              <path
                d="M23.5 34 Q26 30.8 28.5 34"
                fill="none"
                stroke="#2D1606"
                strokeWidth="2.1"
                strokeLinecap="round"
              />
              <path
                d="M35.5 34 Q38 30.8 40.5 34"
                fill="none"
                stroke="#2D1606"
                strokeWidth="2.1"
                strokeLinecap="round"
              />
            </>
          ) : (
            <>
              <circle cx="26" cy="33.2" r="2.5" fill="#2D1606" />
              <circle cx="38" cy="33.2" r="2.5" fill="#2D1606" />
              <circle cx="25.2" cy="32.2" r="0.9" fill="#FFFDF7" />
              <circle cx="37.2" cy="32.2" r="0.9" fill="#FFFDF7" />
            </>
          )}
        </g>

        {/* Expressive mouth */}
        {mood === 'oops' ? (
          <ellipse cx="32" cy="40.2" rx="2.1" ry="2.5" fill="#7C3B0C" />
        ) : mood === 'clarifying' || mood === 'thinking' ? (
          <path
            d="M29.5 40.2 Q32 39.2 34.5 40.2"
            fill="none"
            stroke="#4A2308"
            strokeWidth="1.9"
            strokeLinecap="round"
          />
        ) : (
          <path d="M28 38.8 Q32 43.2 36 38.8" fill="none" stroke="#4A2308" strokeWidth="2.1" strokeLinecap="round" />
        )}
      </g>

      {/* Animated sparkle */}
      <g className={`bread-sparkle-${uid}`}>
        <path d="M52 8 L53.3 11.7 L57 13 L53.3 14.3 L52 18 L50.7 14.3 L47 13 L50.7 11.7 Z" fill="#FBBF24" />
      </g>
    </svg>
  );
}
