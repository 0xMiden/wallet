import React, { FC, useCallback, useMemo, useRef } from 'react';

import { useTranslation } from 'react-i18next';

import { useBackWithFallback } from 'app/hooks/useBackWithFallback';
import { Icon, IconName } from 'app/icons/v2';
import { AnalyticsEventCategory, AnalyticsEventEnum, useAnalytics } from 'lib/analytics';
import { getCurrentLocale, updateLocale } from 'lib/i18n/react';
import { hapticLight } from 'lib/mobile/haptics';
import { PRIMARY_HEX } from 'utils/brand-colors';

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
  const { trackEvent } = useAnalytics();
  const goBackToSettings = useBackWithFallback('/settings');

  const currentCode = useMemo(() => {
    // Underscores, because the list is keyed the way the locale directories are
    // (`zh_CN`) while the resolvers can hand back either form: `getCurrentLocale`
    // normalizes i18next's tag but not its fallbacks, and the extension's
    // `getUILanguage()` returns `zh-CN`.
    const normalized = selectedLocale.replace(/-/g, '_');
    const exact = LANGUAGES.find(({ code }) => code === normalized);
    if (exact) return exact.code;

    const base = normalized.split('_')[0];
    const baseMatch = LANGUAGES.find(({ code }) => code === base);
    if (baseMatch) return baseMatch.code;

    // A base with no unregionalized entry — the only language the wallet ships
    // per-region. On mobile/desktop `getNativeLocale()` truncates to the base, so
    // a Chinese device arrived here as a bare `zh`, matched nothing, and the
    // picker badged English as the current language.
    return LANGUAGES.find(({ code }) => code.startsWith(`${base}_`))?.code || 'en';
  }, [selectedLocale]);

  // `goBack()` is `history.go(-1)`, which lands on a later task, so the rows stay
  // live and mounted after the first tap. As a drawer the exit was an idempotent
  // `onClose`; as a route a second tap ran the whole handler again.
  //
  // NOT redundant with the latch inside `useBackWithFallback`: that one only makes
  // the traversal idempotent, while this also stops a second haptic, a second
  // analytics event and a second `updateLocale` for the row the user grazed.
  const leaving = useRef(false);

  const handleSelect = useCallback(
    (code: string) => {
      if (leaving.current) return;
      leaving.current = true;
      hapticLight();
      trackEvent(AnalyticsEventEnum.LanguageChanged, AnalyticsEventCategory.ButtonPress, { code });
      updateLocale(code);
      // Picking a language finishes the task, so leave. As a drawer this screen was
      // handed an `onClose` by its host; as a route it owns its own exit, and
      // without one the selection silently stranded the user here.
      goBackToSettings();
    },
    [trackEvent, goBackToSettings]
  );

  // Claiming `role="radiogroup"` promises arrow-key navigation, and thirteen rows
  // each keeping the default tabIndex delivered the opposite: a user who knows the
  // pattern presses Down, nothing happens, and Tab now costs thirteen stops to
  // cross. Arrows move focus and select in one step, which is the radio contract —
  // and here selecting also leaves the screen, so it reads as "arrow to the
  // language you want" with no separate confirm.
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
    // A radiogroup, not thirteen loose buttons: the choice is single-select, and
    // that is the only thing that conveys "one of 13" and mutual exclusivity.
    // `aria-pressed` would announce "toggle button, pressed" — a two-state
    // control the user could un-press, when in fact activating the current row
    // just leaves the screen.
    <div className="flex flex-col" role="radiogroup" aria-label={t('language')}>
      {LANGUAGES.map(({ code, label, bcp47 }, index) => {
        const isSelected = code === currentCode;
        return (
          <button
            key={code}
            ref={node => {
              rowsRef.current[index] = node;
            }}
            type="button"
            role="radio"
            // Selection is otherwise conveyed only by colour, weight and an
            // unlabelled checkmark, so a screen reader heard thirteen identical
            // "English, button" rows with no way to tell which one is active.
            aria-checked={isSelected}
            // Roving: one tab stop for the group, arrows to move within it. The
            // stop sits on the current language, so Tab lands where the user is.
            tabIndex={isSelected ? 0 : -1}
            onKeyDown={event => handleKeyDown(event, index)}
            className="flex items-center justify-between py-3 w-full text-left"
            onClick={() => handleSelect(code)}
          >
            {/* Explicit stack without system-ui: on iOS WKWebView, system-ui/-apple-system
                swallow per-glyph fallback so CJK names (日本語, 한국어, 中文) render as
                missing-glyph boxes; falling straight to sans-serif renders them. */}
            <span
              lang={bcp47}
              className={`text-base ${isSelected ? 'text-primary-500 font-semibold' : 'text-heading-gray font-medium'}`}
              style={{ fontFamily: "'Nunito', sans-serif" }}
            >
              {label}
            </span>
            {isSelected && (
              <span aria-hidden="true">
                <Icon name={IconName.Checkmark} size="xs" fill={PRIMARY_HEX} />
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
};

export default LanguageSettings;
