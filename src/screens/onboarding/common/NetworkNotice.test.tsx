import React from 'react';

import { fireEvent, render, screen } from '@testing-library/react';

import { hapticSelection } from 'lib/mobile/haptics';

import { NetworkNoticeScreen } from './NetworkNotice';

jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, string>) => (params ? `${key}:${params.network}` : key)
  })
}));

let mockNetworkKey: 'testnet' | 'devnet' | 'localnet' | null = 'testnet';
jest.mock('lib/miden-chain/effective-endpoints', () => ({
  getTestNetworkNameKey: () => mockNetworkKey
}));

jest.mock('lib/mobile/haptics', () => ({ hapticSelection: jest.fn(), hapticLight: jest.fn() }));

const CHECKS = ['no-value', 'no-real-funds', 'reset'].map(id => `onboarding-network-notice-check-${id}`);

describe('NetworkNoticeScreen', () => {
  beforeEach(() => {
    mockNetworkKey = 'testnet';
  });

  it('names Testnet on a network chip and the step title, on the step layout', () => {
    render(<NetworkNoticeScreen />);

    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('networkModeBanner:testnet');
    expect(screen.getByText('networkNoticeChip:testnet')).toBeInTheDocument();
    expect(screen.getByText('networkNoticeBody')).toHaveClass('text-muted');
    const root = screen.getByTestId('onboarding-network-notice');
    expect(root.querySelector('[data-slot="step-heading"]')).not.toBeNull();
    expect(screen.getByTestId('onboarding-network-notice-acknowledge').closest('[data-slot="footer"]')).not.toBeNull();
  });

  it('lists the three facts as checkboxes in one group, all unchecked', () => {
    render(<NetworkNoticeScreen />);
    const boxes = screen.getAllByRole('checkbox');
    expect(boxes).toHaveLength(3);
    boxes.forEach(box => expect(box).toHaveAttribute('aria-checked', 'false'));
    expect(screen.getByRole('checkbox', { name: 'networkNoticeResetTitle' })).toHaveAccessibleDescription(
      'networkNoticeResetBody'
    );
    CHECKS.forEach(id => expect(screen.getByTestId(id)).toBeInTheDocument());
    expect(boxes[0]!.parentElement).toHaveClass('rounded-2xl', 'bg-fill');
  });

  it('keeps I understand disabled until all three are checked, then acknowledges', () => {
    const onSubmit = jest.fn();
    render(<NetworkNoticeScreen onSubmit={onSubmit} />);
    const button = screen.getByTestId('onboarding-network-notice-acknowledge');
    expect(button).toHaveTextContent('iUnderstand');

    fireEvent.click(button);
    expect(onSubmit).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId(CHECKS[0]!));
    fireEvent.click(screen.getByTestId(CHECKS[1]!));
    expect(button).toBeDisabled();
    // The last one by keyboard.
    fireEvent.keyDown(screen.getByTestId(CHECKS[2]!), { key: 'Enter' });
    expect(button).toBeEnabled();
    expect(hapticSelection).toHaveBeenCalledTimes(3);

    fireEvent.click(button);
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it('disables I understand again when a fact is unchecked', () => {
    render(<NetworkNoticeScreen />);
    CHECKS.forEach(id => fireEvent.click(screen.getByTestId(id)));
    expect(screen.getByTestId('onboarding-network-notice-acknowledge')).toBeEnabled();
    fireEvent.click(screen.getByTestId(CHECKS[1]!));
    expect(screen.getByTestId(CHECKS[1]!)).toHaveAttribute('aria-checked', 'false');
    expect(screen.getByTestId('onboarding-network-notice-acknowledge')).toBeDisabled();
  });

  it('names the effective network, e.g. a devnet override', () => {
    mockNetworkKey = 'devnet';

    render(<NetworkNoticeScreen />);

    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('networkModeBanner:devnet');
    expect(screen.getByText('networkNoticeChip:devnet')).toBeInTheDocument();
  });

  it('renders nothing on mainnet', () => {
    mockNetworkKey = null;

    const { container } = render(<NetworkNoticeScreen />);

    expect(container).toBeEmptyDOMElement();
  });
});
