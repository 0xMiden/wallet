import React from 'react';

import { act, fireEvent, render, screen } from '@testing-library/react';

import { MainnetAccessScreen } from './MainnetAccess';

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

const mockRedeem = jest.fn<Promise<'granted' | 'rejected'>, [string]>();
jest.mock('lib/mainnet-access', () => ({
  MAINNET_ACCESS_CODE_LENGTH: 12,
  isMainnetAccessCodeComplete: (code: string) => /^(?:[0-9]{8}|[A-Za-z0-9]{12})$/.test(code),
  redeemMainnetAccessCode: (code: string) => mockRedeem(code)
}));

const code = () => screen.getByTestId('onboarding-mainnet-access-code');
const submitButton = () => screen.getByTestId('onboarding-mainnet-access-submit');
const type = (value: string) => fireEvent.change(code(), { target: { value } });
const submit = async () => {
  await act(async () => {
    fireEvent.click(submitButton());
  });
};

describe('MainnetAccessScreen', () => {
  beforeEach(() => {
    mockNetworkKey = 'testnet';
    mockRedeem.mockReset();
  });

  it('asks for the code on the step layout, with the way on for a user with no code', () => {
    render(<MainnetAccessScreen />);

    // The navigator's header names the step, so the body opens on its explainer line.
    expect(screen.queryByRole('heading', { level: 1 })).not.toBeInTheDocument();
    expect(screen.getByText('mainnetAccessOnboardingBody')).toHaveClass('text-muted');
    expect(screen.getByRole('textbox', { name: 'mainnetAccessCodeLabel' })).toHaveAttribute('maxlength', '12');
    expect(screen.getByText('mainnetAccessHint')).toBeInTheDocument();
    expect(screen.getByTestId('onboarding-mainnet-access-skip')).toHaveTextContent(
      'mainnetAccessContinueOnNetwork:testnet'
    );
    expect(submitButton().closest('[data-slot="footer"]')).not.toBeNull();
  });

  it('names the effective network on the skip action', () => {
    mockNetworkKey = 'devnet';
    render(<MainnetAccessScreen />);

    expect(screen.getByTestId('onboarding-mainnet-access-skip')).toHaveTextContent(
      'mainnetAccessContinueOnNetwork:devnet'
    );
  });

  it('submits a 12-character code with letter case preserved', async () => {
    mockRedeem.mockResolvedValue('granted');
    const onSubmit = jest.fn();
    render(<MainnetAccessScreen onSubmit={onSubmit} />);
    type('8gKIgL0O6Hc');
    expect(submitButton()).toBeDisabled();
    type('8gKIgL0O6HcU');
    expect(submitButton()).toBeEnabled();
    await submit();
    expect(onSubmit).toHaveBeenCalledWith('8gKIgL0O6HcU');
    expect(mockRedeem).not.toHaveBeenCalled();
  });

  it('renders nothing on mainnet', () => {
    mockNetworkKey = null;
    const { container } = render(<MainnetAccessScreen />);

    expect(container).toBeEmptyDOMElement();
  });

  it('keeps Unlock disabled until the code has eight digits', () => {
    render(<MainnetAccessScreen />);
    expect(submitButton()).toBeDisabled();

    type('4729183');
    expect(submitButton()).toBeDisabled();

    type('47291835');
    expect(submitButton()).toBeEnabled();
  });

  it('keeps the code for account setup without a node request', async () => {
    const onSubmit = jest.fn();
    render(<MainnetAccessScreen onSubmit={onSubmit} />);
    type('8gKIgL0O6HcU');
    await submit();
    expect(onSubmit).toHaveBeenCalledWith('8gKIgL0O6HcU');
    expect(mockRedeem).not.toHaveBeenCalled();
  });

  it('goes on with the test network on the skip action, with no check', () => {
    const onSkip = jest.fn();
    render(<MainnetAccessScreen onSkip={onSkip} />);

    fireEvent.click(screen.getByTestId('onboarding-mainnet-access-skip'));

    expect(onSkip).toHaveBeenCalledTimes(1);
    expect(mockRedeem).not.toHaveBeenCalled();
  });
});
