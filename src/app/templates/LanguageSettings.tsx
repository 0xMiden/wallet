import React, { FC, useCallback, useMemo, useRef } from 'react';

import { useTranslation } from 'react-i18next';

import { useBackWithFallback } from 'app/hooks/useBackWithFallback';
import { useOncePerLocation } from 'app/hooks/useOncePerLocation';
import { ListGroup } from 'components/ui/ListGroup';
import { ListRow } from 'components/ui/ListRow';
import { SubPageLayout } from 'components/ui/SubPageLayout';
import { getCurrentLocale, updateLocale } from 'lib/i18n/react';
import { hapticLight } from 'lib/mobile/haptics';

/**
 * Exported so tests assert against the shipped list rather than a copy of it —
 * a duplicated fixture silently stops covering a language the moment one is
 * added here.
 */
export const LANGUAGES = [
  // `bcp47` is the label's own language, not the app's. Each label is written in
  // the language it names, so without it a screen reader reads all thirteen with
  // the current UI voice — an English voice either mispronounces or skips the
  // CJK and Cyrillic entries outright. This is the one list a user who cannot
  // read the current language has to be able to operate.
  { code: 'en', label: 'English', bcp47: 'en' },
  { code: 'es', label: 'Español', bcp47: 'es' },
  { code: 'fr', label: 'Français', bcp47: 'fr' },
  { code: 'de', label: 'Deutsch', bcp47: 'de' },
  { code: 'zh_CN', label: '简体中文', bcp47: 'zh-Hans' },
  { code: 'zh_TW', label: '繁體中文', bcp47: 'zh-Hant' },
  { code: 'ja', label: '日本語', bcp47: 'ja' },
  { code: 'ko', label: '한국어', bcp47: 'ko' },
  { code: 'pl', label: 'Polski', bcp47: 'pl' },
  { code: 'uk', label: 'Українська', bcp47: 'uk' },
  { code: 'tr', label: 'Türk', bcp47: 'tr' },
  { code: 'pt', label: 'Português', bcp47: 'pt' },
  { code: 'ru', label: 'Русский', bcp47: 'ru' }
];

const LanguageSettings: FC = () => {
  const selectedLocale = getCurrentLocale();
  const { t } = useTranslation();
  const goBackToSettings = useBackWithFallback('/settings');

  const currentCode = useMemo(() => {
    // Underscores, because the list is keyed the way the locale directories are
    // (`zh_CN`) while the resolvers can hand back either form: `getCurrentLocale`
    // normalizes i18next's tag but not its fallbacks, and the extension's
    // `getUILanguage()` returns `zh-CN`.
    const normalized = selectedLocale.replace(/-/g, '_');
    const exact = LANGUAGES.find(({ code }) => code === normalized);
    if (exact) return exact.code;

    // Then the base, which is what makes a regional tag with no regional bundle
    // (`en_GB`) badge the language it actually renders in.
    const base = normalized.split('_')[0];
    const baseMatch = LANGUAGES.find(({ code }) => code === base);
    if (baseMatch) return baseMatch.code;

    // And then English — deliberately, with no "find a region for this base" tier.
    // Such a tier looks like it helps a `zh` device find Chinese, but i18next's
    // resources are keyed `zh-CN`/`zh-TW` with no bare `zh` bundle (src/i18n.ts),
    // so `zh`, `zh-Hans`, `zh-Hant`, `zh-HK` all resolve to `en` and the UI really
    // is in English. Badging 简体中文 there would state the opposite of what is on
    // screen, and would hide the repair: the row that would switch them to Chinese
    // is the one that would be wearing the checkmark. Worse, list order means
    // `startsWith('zh_')` hits `zh_CN` first, so a Traditional-script user would be
    // told they were reading Simplified.
    return 'en';
  }, [selectedLocale]);

  // `goBack()` is `history.go(-1)`, which lands on a later task, so the rows stay
  // live and mounted after the first tap. As a drawer the exit was an idempotent
  // `onClose`; as a route a second tap ran the whole handler again.
  //
  // NOT redundant with the latch inside `useBackWithFallback`: that one only makes
  // the traversal idempotent, while this also stops a second haptic and a second
  // `updateLocale` for the row the user grazed. It re-arms when live history moves:
  // a screen a pop reveals is this same instance, and a latch that never reset left
  // every row dead.
  const claimPick = useOncePerLocation();

  const handleSelect = useCallback(
    (code: string) => {
      if (!claimPick()) return;
      hapticLight();
      updateLocale(code);
      // Picking a language finishes the task, so leave. As a drawer this screen was
      // handed an `onClose` by its host; as a route it owns its own exit, and
      // without one the selection silently stranded the user here.
      goBackToSettings();
    },
    [claimPick, goBackToSettings]
  );

  // Claiming `role="radiogroup"` promises arrow-key navigation, and thirteen rows
  // each keeping the default tabIndex delivered the opposite: a user who knows the
  // pattern presses Down, nothing happens, and Tab now costs thirteen stops to
  // cross. Arrows move focus only, and deliberately do not also select: APG says
  // to avoid selection-following-focus when activation causes a significant
  // context change, and activating here applies the language AND leaves the
  // screen — so arrowing past a row would strand the user in a language they were
  // only passing over. Space or Enter on the focused row commits.
  const rowsRef = useRef<Array<HTMLButtonElement | null>>([]);

  const handleKeyDown = useCallback((event: React.KeyboardEvent<HTMLButtonElement>, index: number) => {
    const step =
      event.key === 'ArrowDown' || event.key === 'ArrowRight'
        ? 1
        : event.key === 'ArrowUp' || event.key === 'ArrowLeft'
          ? -1
          : 0;
    if (step === 0) return;
    event.preventDefault();
    // Wraps, per the pattern: from the last row Down lands on the first.
    const next = (index + step + LANGUAGES.length) % LANGUAGES.length;
    rowsRef.current[next]?.focus();
  }, []);

  return (
    <SubPageLayout data-testid="language-settings">
      {/* A radiogroup, not thirteen loose buttons: the choice is single-select, and
          that is the only thing that conveys "one of 13" and mutual exclusivity.
          `aria-pressed` would announce "toggle button, pressed" — a two-state
          control the user could un-press, when in fact activating the current row
          just leaves the screen. */}
      <div role="radiogroup" aria-label={t('language')}>
        <ListGroup surface="plain">
          {LANGUAGES.map(({ code, label, bcp47 }, index) => {
            const isSelected = code === currentCode;
            return (
              <ListRow
                key={code}
                ref={node => {
                  rowsRef.current[index] = node;
                }}
                radio
                // Selection is conveyed by the row's check and `aria-checked`, so a
                // screen reader hears which of the thirteen is active.
                checked={isSelected}
                // Roving: one tab stop for the group, arrows to move within it. The
                // stop sits on the current language, so Tab lands where the user is.
                tabIndex={isSelected ? 0 : -1}
                onKeyDown={event => handleKeyDown(event, index)}
                // The pick buzzes itself, and only when it is taken: see claimPick.
                haptic={false}
                onClick={() => handleSelect(code)}
                title={
                  // Explicit stack without system-ui: on iOS WKWebView, system-ui/-apple-system
                  // swallow per-glyph fallback so CJK names (日本語, 한국어, 中文) render as
                  // missing-glyph boxes; falling straight to sans-serif renders them.
                  <span lang={bcp47} style={{ fontFamily: "'Nunito', sans-serif" }}>
                    {label}
                  </span>
                }
              />
            );
          })}
        </ListGroup>
      </div>
    </SubPageLayout>
  );
};

export default LanguageSettings;
