import React from 'react';

import { fireEvent, render, screen } from '@testing-library/react';

import { WalletType } from '../types';
import { RecoveryOption, SelectRecoveryMethodScreen } from './SelectRecoveryMethod';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

// `react-i18next` pulls in the full i18n runtime; stub `useTranslation` so
// `t(key)` echoes the key back and every rendered label is the raw key.
jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key })
}));

// `Button` — render the title and forward the click so `onSubmit` wiring can be
// verified without dragging in framer-motion / haptics.
jest.mock('components/Button', () => ({
  Button: ({ title, onClick, className }: { title: string; onClick?: () => void; className?: string }) => (
    <button data-testid="continue-button" data-classname={className} onClick={onClick}>
      {title}
    </button>
  )
}));

// `Pill` — echo the tone and testid as data attributes so the "default" badge
// branch is assertable without pulling in the real component's classes.
jest.mock('components/ui/Pill', () => ({
  Pill: ({
    tone,
    children,
    'data-testid': dataTestId
  }: {
    tone?: string;
    children?: React.ReactNode;
    'data-testid'?: string;
  }) => (
    <span data-testid={dataTestId} data-tone={tone}>
      {children}
    </span>
  )
}));

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

const radio = (name: string) => screen.getByRole('radio', { name });

describe('SelectRecoveryMethodScreen', () => {
  describe('default options', () => {
    it('renders the step layout with both recovery options as radio cards', () => {
      render(<SelectRecoveryMethodScreen data-testid="recovery" />);
      expect(screen.getByRole('heading', { level: 1, name: 'chooseRecoveryMethod' })).toBeInTheDocument();
      expect(screen.getByText('chooseRecoveryMethodDescription')).toBeInTheDocument();
      expect(screen.getByRole('radiogroup', { name: 'chooseRecoveryMethod' })).toBeInTheDocument();
      expect(radio('guardianRecovery')).toHaveTextContent('guardianRecoveryDescription');
      expect(radio('fullyPrivateRecovery')).toHaveTextContent('fullyPrivateRecoveryDescription');
      expect(screen.getByTestId('continue-button').closest('[data-slot="footer"]')).not.toBeNull();
      expect(screen.getByTestId('recovery')).toBeInTheDocument();
    });

    it('renders the "default" badge only on the default (Guardian) option', () => {
      render(<SelectRecoveryMethodScreen />);
      const badges = screen.getAllByTestId('default-badge');
      expect(badges).toHaveLength(1);
      expect(badges[0]).toHaveAttribute('data-tone', 'selected');
      expect(radio('guardianRecovery')).toContainElement(badges[0]!);
    });

    it('pre-selects the default option', () => {
      render(<SelectRecoveryMethodScreen />);
      expect(radio('guardianRecovery')).toHaveAttribute('aria-checked', 'true');
      expect(radio('fullyPrivateRecovery')).toHaveAttribute('aria-checked', 'false');
    });

    it('moves the selection when another option is tapped', () => {
      render(<SelectRecoveryMethodScreen />);
      fireEvent.click(radio('fullyPrivateRecovery'));
      expect(radio('fullyPrivateRecovery')).toHaveAttribute('aria-checked', 'true');
      expect(radio('guardianRecovery')).toHaveAttribute('aria-checked', 'false');
    });

    it('submits the pre-selected (Guardian) wallet type when Continue is clicked', () => {
      const onSubmit = jest.fn();
      render(<SelectRecoveryMethodScreen onSubmit={onSubmit} />);
      fireEvent.click(screen.getByTestId('continue-button'));
      expect(onSubmit).toHaveBeenCalledWith(WalletType.Guardian);
    });

    it('submits the newly-selected wallet type after choosing another option', () => {
      const onSubmit = jest.fn();
      render(<SelectRecoveryMethodScreen onSubmit={onSubmit} />);
      fireEvent.click(radio('fullyPrivateRecovery'));
      fireEvent.click(screen.getByTestId('continue-button'));
      expect(onSubmit).toHaveBeenCalledWith(WalletType.OffChain);
    });

    it('does not throw on Continue without an onSubmit handler', () => {
      render(<SelectRecoveryMethodScreen />);
      expect(() => fireEvent.click(screen.getByTestId('continue-button'))).not.toThrow();
    });
  });

  describe('custom options', () => {
    const custom: RecoveryOption[] = [
      { id: WalletType.OnChain, title: 'Public', description: 'Public account' },
      { id: WalletType.OffChain, title: 'Private', description: 'Private account', isDefault: true }
    ];

    it('renders provided options instead of the defaults, pre-selecting the default one', () => {
      render(<SelectRecoveryMethodScreen options={custom} />);
      expect(screen.queryByText('guardianRecovery')).not.toBeInTheDocument();
      expect(radio('Private')).toHaveAttribute('aria-checked', 'true');
    });

    it('falls back to the first option when none is marked default', () => {
      const onSubmit = jest.fn();
      render(
        <SelectRecoveryMethodScreen options={custom.map(o => ({ ...o, isDefault: false }))} onSubmit={onSubmit} />
      );
      expect(radio('Public')).toHaveAttribute('aria-checked', 'true');
      fireEvent.click(screen.getByTestId('continue-button'));
      expect(onSubmit).toHaveBeenCalledWith(WalletType.OnChain);
    });
  });
});
