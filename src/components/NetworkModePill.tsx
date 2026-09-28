import React, { FC, useLayoutEffect, useRef, useState } from 'react';

import { useTranslation } from 'react-i18next';

import { Icon, IconName } from 'app/icons/v2';
import { NetworkModeSheet } from 'components/NetworkModeSheet';
import { Pill } from 'components/ui';
import { getTestNetworkNameKey } from 'lib/miden-chain/effective-endpoints';

/**
 * The line's size: English at the `md` pill's 14px, every other locale at one smaller size, the
 * largest at which the longest of them (Russian, 378px at 14px) fits a 402pt screen's 308px, so
 * they all read at the same size. On a narrower screen the line shrinks further, down to the floor.
 */
const TEXT_ENGLISH_PX = 14;
const TEXT_OTHER_PX = 11;
const TEXT_MIN_PX = 8;

/**
 * Shrinks the pill's line below `maxPx` only when the whole sentence would not fit on one line at
 * it (a 320pt screen leaves 226px). Text width scales linearly with font size, so one measurement
 * gives the exact fit.
 *
 * The room the line has is measured up to the trailing glyph: `Pill` pushes it to the far end with
 * `ml-auto`, so the space between the line's box and the glyph is room the line may grow into.
 */
function useFitText(active: boolean, maxPx: number) {
  const textRef = useRef<HTMLSpanElement | null>(null);
  const [fontPx, setFontPx] = useState(maxPx);

  useLayoutEffect(() => {
    const text = textRef.current;
    // The text's own box, Pill's truncating label span, then the trailing glyph's box after it.
    const label = text?.parentElement;
    const trailing = label?.nextElementSibling;
    if (!active || !text || !label || !(trailing instanceof HTMLElement)) return;

    const fit = () => {
      const currentPx = parseFloat(getComputedStyle(text).fontSize);
      const gapPx = parseFloat(getComputedStyle(label.parentElement ?? label).columnGap) || 0;
      const available = trailing.offsetLeft - gapPx - label.offsetLeft;
      if (!currentPx || text.offsetWidth === 0 || available <= 0) return;
      const widthAtMax = (text.offsetWidth / currentPx) * maxPx;
      const next = Math.min(maxPx, Math.max(TEXT_MIN_PX, (maxPx * available) / widthAtMax));
      setFontPx(Math.floor(next * 10) / 10);
    };

    fit();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(fit);
    observer.observe(label.parentElement ?? label);
    observer.observe(text);
    return () => observer.disconnect();
  }, [active, maxPx]);

  return { textRef, fontPx };
}

/**
 * The test network's name above Home's balance card, as one full-width pill: the brand dot, the
 * network's name, and why it matters ("Tokens have no real value"), with the info glyph at the far
 * end. English reads at the pill's own size and every other locale a size smaller, so the sentence
 * fits rather than being cut off. Tapping it opens the test-network explanation sheet. It follows the
 * effective network, so a Developer Settings override shows here too, and renders nothing on mainnet.
 */
export const NetworkModePill: FC = () => {
  const { t, i18n } = useTranslation();
  const [open, setOpen] = useState(false);

  const networkKey = getTestNetworkNameKey();
  const isEnglish = (i18n.resolvedLanguage ?? i18n.language ?? 'en').startsWith('en');
  const { textRef, fontPx } = useFitText(networkKey !== null, isEnglish ? TEXT_ENGLISH_PX : TEXT_OTHER_PX);
  if (!networkKey) return null;
  const network = t(networkKey);

  return (
    <>
      <Pill
        onClick={() => setOpen(true)}
        aria-label={t('networkModeStripLabel', { network })}
        aria-haspopup="dialog"
        aria-expanded={open}
        data-testid="network-mode-pill"
        className="w-full"
        icon={<span aria-hidden="true" className="h-2 w-2 rounded-full bg-accent-primary" />}
        trailingIcon={<Icon name={IconName.Information} size="xs" fill="currentColor" className="text-muted" />}
      >
        <span ref={textRef} style={{ fontSize: `${fontPx}px` }} data-testid="network-mode-pill-text">
          {network}
          {/* eslint-disable-next-line i18next/no-literal-string -- separator glyph, not translatable copy */}
          <span className="px-1.5 text-muted">·</span>
          <span className="text-muted">{t('networkModePillNoValue')}</span>
        </span>
      </Pill>

      <NetworkModeSheet open={open} onOpenChange={setOpen} />
    </>
  );
};
