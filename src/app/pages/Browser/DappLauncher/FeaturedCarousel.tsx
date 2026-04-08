/**
 * Horizontal snap-scroll carousel of large featured-dApp cards.
 *
 * Each card is ~280×160 with the dApp's brand color as background, the
 * icon top-left, the name + tagline overlaid bottom-left, and a small
 * badge if present. The carousel uses CSS scroll-snap so it feels native
 * (no JS gesture work needed). Cards are tappable to open the dApp.
 *
 * `overscroll-behavior: contain` prevents the host webview's pull-to-
 * refresh from kicking in.
 */

import React, { type FC } from 'react';

import { useTranslation } from 'react-i18next';

import { CAROUSEL_DAPPS, type FeaturedDapp } from 'lib/dapp-browser';
import { hapticLight } from 'lib/mobile/haptics';

interface FeaturedCarouselProps {
  onOpen: (url: string) => void;
}

export const FeaturedCarousel: FC<FeaturedCarouselProps> = ({ onOpen }) => {
  const { t } = useTranslation();

  if (CAROUSEL_DAPPS.length === 0) return null;

  // No scroll-snap (snap-x snap-mandatory) here. iOS Safari recomputes
  // snap points when the parent's CSS transform changes during
  // TabLayout's mobile-slide-in, and the snap correction at the end of
  // the slide-in shows up as a visible reverse-jiggle. The carousel
  // still scrolls horizontally and the user can swipe between cards;
  // they just don't snap to a card edge automatically.
  return (
    <section>
      <h2 className="mb-3 px-4 text-sm font-semibold uppercase tracking-wide text-grey-500">{t('featuredDapps')}</h2>
      <div
        className="flex gap-3 overflow-x-auto pb-2 pl-4 pr-4"
        style={{ overscrollBehavior: 'contain', scrollbarWidth: 'none' }}
      >
        {CAROUSEL_DAPPS.map(dapp => (
          <FeaturedCard key={dapp.id} dapp={dapp} onOpen={onOpen} />
        ))}
      </div>
    </section>
  );
};

const FeaturedCard: FC<{ dapp: FeaturedDapp; onOpen: (url: string) => void }> = ({ dapp, onOpen }) => {
  const handleClick = () => {
    hapticLight();
    onOpen(dapp.url);
  };

  // Use onClick (NOT onPointerDown) so the WebView can discriminate
  // tap vs swipe. onPointerDown fires the instant a finger touches the
  // card — before the horizontal scroll-snap can register a drag —
  // which prevented the carousel from being swipeable at all.
  return (
    <button
      type="button"
      onClick={handleClick}
      className="relative h-40 w-[260px] shrink-0 overflow-hidden rounded-3xl text-left shadow-[0_8px_24px_rgba(15,23,42,0.12)] active:scale-[0.98] transition-transform"
      style={{ background: dapp.brandColor }}
      aria-label={dapp.name}
    >
      {/* Top-right badge — no backdrop-blur here. iOS Safari's
          backdrop-filter lags parent CSS transforms and snaps into
          position at the end of TabLayout's mobile-slide-in, which
          shows up as a visible reverse-jiggle on /browser. The plain
          translucent white background looks fine on every brand
          color we ship. */}
      {dapp.badge && (
        <span className="absolute right-3 top-3 rounded-full bg-pure-white/30 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-pure-white">
          {dapp.badge}
        </span>
      )}

      {/* Icon top-left — same reasoning, no backdrop-blur. */}
      <div className="absolute left-4 top-4 flex h-12 w-12 items-center justify-center rounded-2xl bg-pure-white/25">
        <img src={dapp.icon} alt="" className="h-9 w-9 object-contain" draggable={false} />
      </div>

      {/* Name + tagline bottom */}
      <div className="absolute inset-x-4 bottom-4">
        <div className="text-lg font-semibold text-pure-white drop-shadow-sm">{dapp.name}</div>
        <div className="mt-0.5 text-xs text-pure-white/80 drop-shadow-sm">{dapp.shortDescription}</div>
      </div>

      {/* Subtle gradient overlay so text is readable on bright brand colors */}
      <div className="pointer-events-none absolute inset-0 bg-gradient-to-t from-black/30 via-transparent to-transparent" />
    </button>
  );
};
