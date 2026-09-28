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
 * it (a 320pt screen leaves 226px). The glyphs scale linearly with font size and the separator's
 * padding does not, so one measurement gives the exact fit.
 *
 * The room the line has is measured up to the trailing glyph: `Pill` pushes it to the far end with
 * `ml-auto`, so the space between the label's box and the glyph is room the line may grow into. The
 * fit re-runs when the sentence changes (its network or language), once web fonts load, and when the
 * pill resizes. The line itself is inline, a box ResizeObserver never reports.
 */
function useFitText(active: boolean, maxPx: number, network: string, language: string) {
  const textRef = useRef<HTMLSpanElement | null>(null);
  const separatorRef = useRef<HTMLSpanElement | null>(null);
  const [fontPx, setFontPx] = useState(maxPx);

  useLayoutEffect(() => {
    const text = textRef.current;
    const label = text?.closest('[data-slot="pill-label"]');
    const pill = label?.parentElement;
    const trailing = pill?.querySelector('[data-slot="pill-trailing"]');
    if (!active || !text || !(label instanceof HTMLElement) || !pill || !(trailing instanceof HTMLElement)) return;

    const fit = () => {
      const currentPx = parseFloat(getComputedStyle(text).fontSize);
      const gapPx = parseFloat(getComputedStyle(pill).columnGap) || 0;
      const separator = separatorRef.current && getComputedStyle(separatorRef.current);
      const fixedPx = separator
        ? (parseFloat(separator.paddingLeft) || 0) + (parseFloat(separator.paddingRight) || 0)
        : 0;
      // The rects, not offsetLeft and offsetWidth: those round to whole pixels, which can overstate
      // the room by more than the 0.1px step leaves spare.
      const available = trailing.getBoundingClientRect().left - gapPx - label.getBoundingClientRect().left;
      const scalablePx = text.getBoundingClientRect().width - fixedPx;
      if (!currentPx || scalablePx <= 0 || available <= fixedPx) return;
      const next = Math.min(maxPx, Math.max(TEXT_MIN_PX, ((available - fixedPx) * currentPx) / scalablePx));
      setFontPx(Math.floor(next * 10) / 10);
    };

    fit();
    const fonts: FontFaceSet | undefined = document.fonts;
    fonts?.addEventListener('loadingdone', fit);
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(fit);
    observer?.observe(pill);
    return () => {
      fonts?.removeEventListener('loadingdone', fit);
      observer?.disconnect();
    };
  }, [active, maxPx, network, language]);

  return { textRef, separatorRef, fontPx };
}

/**
 * The test network's name above Home's balance card, as one full-width pill: the brand dot, the
 * network's name, and why it matters ("Tokens have no real value"), with the info glyph at the far
 * end. English reads at the pill's own size and every other locale a size smaller, so the sentence
 * fits rather than being cut off. Tapping it opens the test-network explanation sheet. Its accessible
 * name is that sentence, with no `aria-label` over it, so voice control matches the words on screen.
 * It follows the effective network, so a Developer Settings override shows here too, and renders
 * nothing on mainnet.
 */
export const NetworkModePill: FC = () => {
  const { t, i18n } = useTranslation();
  const [open, setOpen] = useState(false);

  const networkKey = getTestNetworkNameKey();
  const network = networkKey ? t(networkKey) : '';
  const language = i18n.resolvedLanguage ?? i18n.language ?? 'en';
  const maxPx = language.startsWith('en') ? TEXT_ENGLISH_PX : TEXT_OTHER_PX;
  const { textRef, separatorRef, fontPx } = useFitText(networkKey !== null, maxPx, network, language);
  if (!networkKey) return null;

  return (
    <>
      <Pill
        onClick={() => setOpen(true)}
        aria-haspopup="dialog"
        aria-expanded={open}
        data-testid="network-mode-pill"
        className="w-full"
        icon={<span aria-hidden="true" className="h-2 w-2 rounded-full bg-accent-primary" />}
        trailingIcon={<Icon name={IconName.Information} size="xs" fill="currentColor" className="text-muted" />}
      >
        <span ref={textRef} style={{ fontSize: `${fontPx}px` }} data-testid="network-mode-pill-text">
          {network}
          <span ref={separatorRef} className="px-1.5 text-muted">
            {/* eslint-disable-next-line i18next/no-literal-string -- separator glyph, not translatable copy */}
            {'·'}
          </span>
          <span className="text-muted">{t('networkModePillNoValue')}</span>
        </span>
      </Pill>

      <NetworkModeSheet open={open} onOpenChange={setOpen} />
    </>
  );
};
