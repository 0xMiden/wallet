import React from 'react';

import { render, screen, fireEvent } from '@testing-library/react';

import { ImportType } from '../types';

import { SelectImportTypeScreen } from './SelectImportType';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

// `react-i18next` pulls in the full i18n runtime; stub `useTranslation` so
// `t(key)` echoes the key back and every rendered label is the raw key.
jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key })
}));

// `app/icons/arrow-right.svg` is already remapped to the shared svgMock
// (`ReactComponent: 'svg'`) by the jest config, so the icon renders as a bare
// <svg> element carrying whatever props the screen forwards.

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const renderComponent = (onSubmit?: (payload: ImportType) => void) =>
  render(<SelectImportTypeScreen onSubmit={onSubmit} />);

describe('SelectImportTypeScreen', () => {
  it('renders the container with its test id', () => {
    renderComponent();
    expect(screen.getByTestId('import-select-type')).toBeInTheDocument();
  });

  it('renders the heading and description copy', () => {
    renderComponent();
    expect(screen.getByText('chooseImportType')).toBeInTheDocument();
    expect(screen.getByText('chooseImportTypeDescription')).toBeInTheDocument();
  });

  it('renders both import-type options with their titles and descriptions', () => {
    renderComponent();

    // Seed-phrase option
    expect(screen.getByText('importWithSeedPhrase')).toBeInTheDocument();
    expect(screen.getByText('importWithSeedPhraseDescription')).toBeInTheDocument();

    // Encrypted-wallet-file option
    expect(screen.getByText('importWithEncryptedWalletFile')).toBeInTheDocument();
    expect(screen.getByText('importWithEncryptedWalletFileDescription')).toBeInTheDocument();
  });

  it('renders an arrow icon for each option', () => {
    const { container } = renderComponent();
    expect(container.querySelectorAll('svg')).toHaveLength(2);
  });

  it('invokes onSubmit with SeedPhrase when the seed-phrase option is clicked', () => {
    const onSubmit = jest.fn();
    renderComponent(onSubmit);

    fireEvent.click(screen.getByText('importWithSeedPhrase'));

    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledWith(ImportType.SeedPhrase);
  });

  it('invokes onSubmit with WalletFile when the wallet-file option is clicked', () => {
    const onSubmit = jest.fn();
    renderComponent(onSubmit);

    fireEvent.click(screen.getByText('importWithEncryptedWalletFile'));

    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledWith(ImportType.WalletFile);
  });

  it('does not throw when an option is clicked without an onSubmit handler', () => {
    renderComponent();

    // Exercises the optional-chaining short-circuit (`onSubmit?.(...)`) branch.
    expect(() => fireEvent.click(screen.getByText('importWithSeedPhrase'))).not.toThrow();
  });

  it('does not invoke onSubmit before any interaction', () => {
    const onSubmit = jest.fn();
    renderComponent(onSubmit);
    expect(onSubmit).not.toHaveBeenCalled();
  });
});
