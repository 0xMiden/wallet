import React, { useMemo, useCallback, FC } from 'react';

import classNames from 'clsx';
import { useTranslation } from 'react-i18next';

import Flag from 'app/atoms/Flag';
import { AnalyticsEventCategory, AnalyticsEventEnum, useAnalytics } from 'lib/analytics';
import { getCurrentLocale, updateLocale } from 'lib/i18n/react';
import { isMobile } from 'lib/platform';

import IconifiedSelect, { IconifiedSelectOptionRenderProps } from './IconifiedSelect';

type LocaleSelectProps = {
  className?: string;
};

type LocaleOption = {
  code: string;
  disabled: boolean;
  flagName: string;
  label: string;
};

const localeOptions: LocaleOption[] = [
  {
    code: 'en',
    flagName: 'us',
    label: 'English',
    disabled: false
  },
  {
    code: 'es',
    flagName: 'es',
    label: 'Spanish (Español)',
    disabled: false
  },
  {
    code: 'fr',
    flagName: 'fr',
    label: 'French (Français)',
    disabled: false
  },
  {
    code: 'de',
    flagName: 'de',
    label: 'German (Deutsch)',
    disabled: false
  },
  {
    code: 'zh_CN',
    flagName: 'cn',
    label: 'Chinese ‒ Simplified (简体中文)',
    disabled: false
  },
  {
    code: 'zh_TW',
    flagName: 'tw',
    label: 'Chinese ‒ Traditional (繁體中文)',
    disabled: false
  },
  {
    code: 'ja',
    flagName: 'jp',
    label: 'Japanese (日本語)',
    disabled: false
  },
  {
    code: 'ko',
    flagName: 'kr',
    label: 'Korean',
    disabled: false
  },
  {
    code: 'pl',
    flagName: 'pl',
    label: 'Polish (Polski)',
    disabled: false
  },
  {
    code: 'uk',
    flagName: 'ua',
    label: 'Ukrainian (Українська)',
    disabled: false
  },
  {
    code: 'tr',
    flagName: 'tr',
    label: 'Turkish (Türk)',
    disabled: false
  },
  {
    code: 'pt',
    flagName: 'pt',
    label: 'Portuguese (Português)',
    disabled: false
  },
  {
    code: 'ru',
    flagName: 'ru',
    label: 'Russian (Русский)',
    disabled: false
  }
];

const localeIsDisabled = ({ disabled }: LocaleOption) => !!disabled;

const getLocaleCode = ({ code }: LocaleOption) => code;

const LocaleSelect: FC<LocaleSelectProps> = ({ className }) => {
  const selectedLocale = getCurrentLocale();
  const { trackEvent } = useAnalytics();

  const value = useMemo(() => {
    // Try exact match first (handles zh_CN, zh_TW)
    const exact = localeOptions.find(({ code }) => code === selectedLocale);
    if (exact) return exact;
    // Fall back to base language match (handles de_DE → de, en-US → en)
    const base = selectedLocale.split(/[-_]/)[0];
    return localeOptions.find(({ code }) => code === base) || localeOptions[0];
  }, [selectedLocale]);

  const handleLocaleChange = useCallback(
    ({ code }: LocaleOption) => {
      trackEvent(AnalyticsEventEnum.LanguageChanged, AnalyticsEventCategory.ButtonPress, { code });
      updateLocale(code);
    },
    [trackEvent]
  );

  return (
    <IconifiedSelect
      Icon={LocaleIcon}
      OptionSelectedIcon={LocaleIcon}
      OptionInMenuContent={LocaleInMenuContent}
      OptionSelectedContent={LocaleSelectContent}
      getKey={getLocaleCode}
      isDisabled={localeIsDisabled}
      options={localeOptions}
      value={value}
      onChange={handleLocaleChange}
      title={null}
      className={className}
    />
  );
};

export default LocaleSelect;

const LocaleIcon: FC<IconifiedSelectOptionRenderProps<LocaleOption>> = ({ option: { flagName, code } }) => {
  // On mobile, use relative URL; on extension, use browser.runtime.getURL
  const flagUrl = isMobile()
    ? `/misc/country-flags/flag-${flagName}.svg`
    : (() => {
        try {
          // eslint-disable-next-line @typescript-eslint/no-var-requires
          const browser = require('webextension-polyfill');
          return browser.runtime.getURL(`/misc/country-flags/flag-${flagName}.svg`);
        } catch {
          return `/misc/country-flags/flag-${flagName}.svg`;
        }
      })();

  return <Flag alt={code} className="ml-2 mr-3" src={flagUrl} />;
};

const LocaleInMenuContent: FC<IconifiedSelectOptionRenderProps<LocaleOption>> = ({ option: { disabled, label } }) => {
  const { t } = useTranslation();
  return (
    <div className={classNames('relative w-full text-base text-black')}>
      {label}

      {disabled && (
        <div className={classNames('absolute top-0 bottom-0 right-0', 'flex items-center')}>
          <div
            className={classNames(
              'mr-2 px-1',
              'bg-orange-500 rounded-sm shadow-md',
              'text-white',
              'text-xs font-semibold uppercase'
            )}
          >
            {t('soon')}
          </div>
        </div>
      )}
    </div>
  );
};

const LocaleSelectContent: FC<IconifiedSelectOptionRenderProps<LocaleOption>> = ({ option }) => {
  return (
    <div className="flex flex-col items-start py-2">
      <span className="text-lg text-black">{option.label}</span>
    </div>
  );
};
