/**
 * Top-of-launcher search bar — the shared `<SearchInput>` styled box.
 *
 * Accepts either a search query (we don't actually search — the input is
 * normalized and treated as a URL via `normalizeUrl`) or a pasted URL.
 * Hitting enter / the keyboard's go key calls `onSubmit(normalizedUrl)`.
 */

import React, { type FC, useCallback, useState } from 'react';

import { useTranslation } from 'react-i18next';

import { SearchInput } from 'components/ui';
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

  return (
    <div className="px-4">
      <SearchInput
        value={value}
        onChange={setValue}
        onSubmit={submit}
        placeholder={t('searchDapps')}
        inputMode="url"
        data-testid="dapp-hero-search"
      />
    </div>
  );
};
