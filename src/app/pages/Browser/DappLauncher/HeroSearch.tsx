/**
 * Top-of-launcher search bar.
 *
 * Larger / more prominent than the PR-1 minimal URL bar. Accepts either a
 * search query (PR-2 doesn't actually search — it just normalizes whatever
 * the user typed and treats it as a URL via `normalizeUrl`) or a pasted URL.
 * Hitting enter or tapping `Go` calls `onSubmit(normalizedUrl)`.
 */

import React, { type FC, useCallback, useState } from 'react';

import { useTranslation } from 'react-i18next';

import { Icon, IconName } from 'app/icons/v2';
import { hapticLight } from 'lib/mobile/haptics';

interface HeroSearchProps {
  onSubmit: (url: string) => void;
}

function normalizeUrl(input: string): string {
  let normalized = input.trim();
  if (!normalized) return '';
  if (!normalized.startsWith('http://') && !normalized.startsWith('https://')) {
    normalized = 'https://' + normalized;
  }
  return normalized;
}

export const HeroSearch: FC<HeroSearchProps> = ({ onSubmit }) => {
  const { t } = useTranslation();
  const [value, setValue] = useState('');

  const submit = useCallback(() => {
    const normalized = normalizeUrl(value);
    if (!normalized) return;
    hapticLight();
    onSubmit(normalized);
  }, [value, onSubmit]);

  const handleSubmit = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();
      submit();
    },
    [submit]
  );

  return (
    <form onSubmit={handleSubmit} className="px-4">
      <div
        className="flex h-12 w-full items-center gap-3 rounded-2xl border border-grey-100 bg-pure-white px-4 shadow-[0_2px_8px_rgba(15,23,42,0.04)]"
        style={{
          backdropFilter: 'blur(20px) saturate(1.6)',
          WebkitBackdropFilter: 'blur(20px) saturate(1.6)'
        }}
      >
        <Icon name={IconName.Search} size="sm" className="shrink-0 text-grey-400" />
        <input
          type="text"
          value={value}
          onChange={e => setValue(e.target.value)}
          placeholder={t('searchDapps')}
          className="grow bg-transparent text-base text-grey-800 placeholder:text-grey-400 focus:outline-none"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          inputMode="url"
        />
        {value.length > 0 && (
          <button
            type="submit"
            className="shrink-0 rounded-full bg-primary-500 px-3 py-1 text-xs font-semibold text-pure-white"
          >
            {t('go')}
          </button>
        )}
      </div>
    </form>
  );
};
