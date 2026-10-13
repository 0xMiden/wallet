import React from 'react';

import { act, fireEvent, render, screen } from '@testing-library/react';

import { MainnetAccessScreen } from './MainnetAccess';

jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key })
}));

jest.mock('lib/mobile/haptics', () => ({ hapticSelection: jest.fn(), hapticLight: jest.fn() }));

const mockCheck = jest.fn<Promise<'granted' | 'rejected'>, [string]>();
const mockWrite = jest.fn<Promise<void>, [{ string: string }]>();
jest.mock('@capacitor/clipboard', () => ({ Clipboard: { write: (value: { string: string }) => mockWrite(value) } }));
jest.mock('lib/mainnet-access', () => ({
  MAINNET_ACCESS_CODE_LENGTH: 12,
  isMainnetAccessCodeComplete: (code: string) => /^(?:[0-9]{8}|[A-Za-z0-9]{12})$/.test(code),
  checkMainnetAccessCode: (code: string) => mockCheck(code)
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
    mockCheck.mockReset();
    mockWrite.mockReset().mockResolvedValue(undefined);
  });

  it('asks for the code on the step layout, with its own title and no way on without a code', () => {
    render(<MainnetAccessScreen />);

    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('mainnetAccessTitle');
    expect(screen.getByText('mainnetAccessOnboardingBody')).toHaveClass('text-muted');
    expect(screen.getByRole('textbox', { name: 'mainnetAccessCodeLabel' })).toHaveAttribute('maxlength', '12');
    expect(screen.getByText('mainnetAccessHint')).toBeInTheDocument();
    expect(screen.queryByTestId('onboarding-mainnet-access-skip')).not.toBeInTheDocument();
    expect(submitButton().closest('[data-slot="footer"]')).not.toBeNull();
  });

  it('keeps Unlock disabled until the code is complete', () => {
    render(<MainnetAccessScreen />);
    expect(submitButton()).toBeDisabled();

    type('4729183');
    expect(submitButton()).toBeDisabled();

    type('47291835');
    expect(submitButton()).toBeEnabled();

    type('8gKIgL0O6Hc');
    expect(submitButton()).toBeDisabled();

    type('8gKIgL0O6HcU');
    expect(submitButton()).toBeEnabled();
  });

  it('copies the entered code with its letter case and does not submit the form', async () => {
    render(<MainnetAccessScreen />);
    const copy = screen.getByTestId('onboarding-mainnet-access-copy');
    expect(copy).toBeDisabled();
    type('8gKIgL0O6HcU');
    await act(async () => {
      fireEvent.click(copy);
    });
    expect(mockWrite).toHaveBeenCalledWith({ string: '8gKIgL0O6HcU' });
    expect(copy).toHaveAttribute('data-copied', 'true');
    expect(mockCheck).not.toHaveBeenCalled();
  });

  it('asks the node, then hands an accepted code on with letter case preserved', async () => {
    mockCheck.mockResolvedValue('granted');
    const onSubmit = jest.fn();
    render(<MainnetAccessScreen onSubmit={onSubmit} />);
    type('8gKIgL0O6HcU');
    await submit();
    expect(mockCheck).toHaveBeenCalledWith('8gKIgL0O6HcU');
    expect(onSubmit).toHaveBeenCalledWith('8gKIgL0O6HcU');
    expect(screen.queryByTestId('onboarding-mainnet-access-error')).not.toBeInTheDocument();
  });

  it('shows the refusal for a rejected code, and clears it on the next edit', async () => {
    mockCheck.mockResolvedValue('rejected');
    const onSubmit = jest.fn();
    render(<MainnetAccessScreen onSubmit={onSubmit} />);
    type('47291835');
    await submit();
    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByTestId('onboarding-mainnet-access-error')).toHaveTextContent('mainnetAccessCodeRejected');

    type('47291836');
    expect(screen.queryByTestId('onboarding-mainnet-access-error')).not.toBeInTheDocument();
  });

  it('says the check did not complete when the node fails, and keeps the code', async () => {
    mockCheck.mockRejectedValue(new Error('timeout'));
    const onSubmit = jest.fn();
    render(<MainnetAccessScreen onSubmit={onSubmit} />);
    type('8gKIgL0O6HcU');
    await submit();
    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByTestId('onboarding-mainnet-access-error')).toHaveTextContent('mainnetAccessCheckFailed');
    expect(code()).toHaveValue('8gKIgL0O6HcU');
    expect(submitButton()).toBeEnabled();
  });

  it('does not ask twice while a check is running', async () => {
    let settle: (outcome: 'granted') => void = () => {};
    mockCheck.mockReturnValue(new Promise(resolve => (settle = resolve)));
    render(<MainnetAccessScreen />);
    type('8gKIgL0O6HcU');
    await submit();
    await submit();
    expect(mockCheck).toHaveBeenCalledTimes(1);
    await act(async () => settle('granted'));
  });
});
