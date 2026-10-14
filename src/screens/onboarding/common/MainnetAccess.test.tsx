import React from 'react';

import { act, fireEvent, render, screen } from '@testing-library/react';

import { MainnetAccessScreen } from './MainnetAccess';

jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key })
}));

jest.mock('lib/mobile/haptics', () => ({ hapticSelection: jest.fn(), hapticLight: jest.fn() }));

const mockCheck = jest.fn<Promise<'granted' | 'rejected'>, [string]>();
const mockRead = jest.fn<Promise<{ value: string; type: string }>, []>();
jest.mock('@capacitor/clipboard', () => ({ Clipboard: { read: () => mockRead() } }));
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
    mockRead.mockReset().mockResolvedValue({ value: '8gKI-gL0O 6HcUextra', type: 'text/plain' });
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

  it('pastes a code with its letter case, removes separators, and does not submit', async () => {
    render(<MainnetAccessScreen />);
    const paste = screen.getByTestId('onboarding-mainnet-access-paste');
    expect(paste).toBeEnabled();
    await act(async () => {
      fireEvent.click(paste);
    });
    expect(mockRead).toHaveBeenCalledTimes(1);
    expect(code()).toHaveValue('8gKIgL0O6HcU');
    expect(mockCheck).not.toHaveBeenCalled();
  });

  it('keeps the entered code when clipboard access fails', async () => {
    mockRead.mockRejectedValueOnce(new Error('Clipboard denied'));
    render(<MainnetAccessScreen />);
    type('47291835');
    await act(async () => {
      fireEvent.click(screen.getByTestId('onboarding-mainnet-access-paste'));
    });
    expect(code()).toHaveValue('47291835');
    expect(screen.getByRole('alert')).toHaveTextContent('mainnetAccessPasteFailed');
  });

  it('keeps the entered code when the clipboard is empty', async () => {
    mockRead.mockResolvedValueOnce({ value: '', type: 'text/plain' });
    render(<MainnetAccessScreen />);
    type('47291835');
    await act(async () => {
      fireEvent.click(screen.getByTestId('onboarding-mainnet-access-paste'));
    });
    expect(code()).toHaveValue('47291835');
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

  it('opens with the refusal when the node refused the last code at registration', () => {
    render(<MainnetAccessScreen rejected />);
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

  it('drops a granted check that answers after the screen closed', async () => {
    let settle: (outcome: 'granted') => void = () => {};
    mockCheck.mockReturnValue(new Promise(resolve => (settle = resolve)));
    const onSubmit = jest.fn();
    const view = render(<MainnetAccessScreen onSubmit={onSubmit} />);
    type('8gKIgL0O6HcU');
    await submit();
    view.unmount();
    await act(async () => settle('granted'));
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('drops a check whose code changed before it answered', async () => {
    let settle: (outcome: 'granted') => void = () => {};
    mockCheck.mockReturnValue(new Promise(resolve => (settle = resolve)));
    const onSubmit = jest.fn();
    render(<MainnetAccessScreen onSubmit={onSubmit} />);
    type('8gKIgL0O6HcU');
    await submit();
    type('47291835');
    await act(async () => settle('granted'));
    expect(onSubmit).not.toHaveBeenCalled();
    expect(code()).toHaveValue('47291835');
    expect(submitButton()).toBeEnabled();
  });
});
