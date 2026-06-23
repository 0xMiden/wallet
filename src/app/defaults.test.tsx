/**
 * app/defaults — pure helpers and the i18n-backed badge/caption surfaces.
 * Covers formatMnemonic (newline → space + trim), the deprecated
 * getAccountBadgeTitle constant, the useAccountBadgeTitle hook, and the
 * MnemonicErrorCaption list.
 */

import React from 'react';

import { render, renderHook } from '@testing-library/react';

import { MnemonicErrorCaption, formatMnemonic, getAccountBadgeTitle, useAccountBadgeTitle } from './defaults';

jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key
  })
}));

describe('app/defaults', () => {
  describe('formatMnemonic', () => {
    it('replaces newlines with spaces and trims surrounding whitespace', () => {
      expect(formatMnemonic('  alpha\nbravo\ncharlie  ')).toBe('alpha bravo charlie');
    });

    it('leaves an already-clean single-line phrase untouched', () => {
      expect(formatMnemonic('alpha bravo charlie')).toBe('alpha bravo charlie');
    });
  });

  describe('getAccountBadgeTitle', () => {
    it('returns the deprecated static "Imported" label', () => {
      expect(getAccountBadgeTitle()).toBe('Imported');
    });
  });

  describe('useAccountBadgeTitle', () => {
    it('returns the translated imported-account label', () => {
      const { result } = renderHook(() => useAccountBadgeTitle());
      expect(result.current).toBe('importedAccount');
    });
  });

  describe('MnemonicErrorCaption', () => {
    it('renders the three mnemonic-constraint list items', () => {
      const { getByText } = render(<MnemonicErrorCaption />);
      expect(getByText('mnemonicWordsAmountConstraint')).toBeInTheDocument();
      expect(getByText('mnemonicSpacingConstraint')).toBeInTheDocument();
      expect(getByText('justValidPreGeneratedMnemonic')).toBeInTheDocument();
    });
  });
});
