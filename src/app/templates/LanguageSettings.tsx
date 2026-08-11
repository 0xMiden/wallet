import React, { FC, useCallback, useMemo } from 'react';

import { Icon, IconName } from 'app/icons/v2';
import { AnalyticsEventCategory, AnalyticsEventEnum, useAnalytics } from 'lib/analytics';
import { getCurrentLocale, updateLocale } from 'lib/i18n/react';
import { hapticLight } from 'lib/mobile/haptics';
import { PRIMARY_HEX } from 'utils/brand-colors';

const LANGUAGES = [
  { code: 'en', label: 'English' },
  { code: 'es', label: 'Español' },
  { code: 'fr', label: 'Français' },
  { code: 'de', label: 'Deutsch' },
  { code: 'zh_CN', label: '简体中文' },
  { code: 'zh_TW', label: '繁體中文' },
  { code: 'ja', label: '日本語' },
  { code: 'ko', label: '한국어' },
  { code: 'pl', label: 'Polski' },
  { code: 'uk', label: 'Українська' },
  { code: 'tr', label: 'Türk' },
  { code: 'pt', label: 'Português' },
  { code: 'ru', label: 'Русский' }
];

type LanguageSettingsProps = {
  onClose?: () => void;
};

const LanguageSettings: FC<LanguageSettingsProps> = ({ onClose }) => {
  const selectedLocale = getCurrentLocale();
  const { trackEvent } = useAnalytics();

  const currentCode = useMemo(() => {
    const exact = LANGUAGES.find(({ code }) => code === selectedLocale);
    if (exact) return exact.code;
    const base = selectedLocale.split(/[-_]/)[0];
    return LANGUAGES.find(({ code }) => code === base)?.code || 'en';
  }, [selectedLocale]);

  const handleSelect = useCallback(
    (code: string) => {
      hapticLight();
      trackEvent(AnalyticsEventEnum.LanguageChanged, AnalyticsEventCategory.ButtonPress, { code });
      updateLocale(code);
      onClose?.();
    },
    [trackEvent, onClose]
  );

  return (
    <div className="flex flex-col">
      {LANGUAGES.map(({ code, label }) => {
        const isSelected = code === currentCode;
        return (
          <button
            key={code}
            type="button"
            className="flex items-center justify-between py-3 w-full text-left"
            onClick={() => handleSelect(code)}
          >
            {/* Explicit stack without system-ui: on iOS WKWebView, system-ui/-apple-system
                swallow per-glyph fallback so CJK names (日本語, 한국어, 中文) render as
                missing-glyph boxes; falling straight to sans-serif renders them. */}
            <span
              className={`text-base ${isSelected ? 'text-primary-500 font-semibold' : 'text-heading-gray font-medium'}`}
              style={{ fontFamily: "'Nunito', sans-serif" }}
            >
              {label}
            </span>
            {isSelected && <Icon name={IconName.Checkmark} size="xs" fill={PRIMARY_HEX} />}
          </button>
        );
      })}
    </div>
  );
};

export default LanguageSettings;
