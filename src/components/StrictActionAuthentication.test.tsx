import React from 'react';

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';

import { StrictActionAuthentication } from './StrictActionAuthentication';

const mockGetPlatform = jest.fn(() => 'extension');
const mockGetProtectors = jest.fn();
const mockVerify = jest.fn();

jest.mock('lib/platform', () => ({
  getPlatform: () => mockGetPlatform(),
  isDesktop: () => mockGetPlatform() === 'desktop',
  isExtension: () => mockGetPlatform() === 'extension',
  isMobile: () => mockGetPlatform() === 'mobile'
}));

jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key })
}));

jest.mock('lib/store', () => ({
  useWalletStore: (selector: (state: unknown) => unknown) =>
    selector({
      getStrictAuthenticationProtectors: mockGetProtectors,
      verifyStrictActionAuthentication: mockVerify
    })
}));

jest.mock('components/PasscodeEntry', () => ({
  PasscodeEntry: ({ onSubmit, error }: { onSubmit: (value: string) => void; error?: string }) => (
    <div>
      {error && <span>{error}</span>}
      <button type="button" onClick={() => onSubmit('123456')}>
        enter-passcode
      </button>
    </div>
  )
}));

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>(next => {
    resolve = next;
  });
  return { promise, resolve };
};

describe('StrictActionAuthentication', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetPlatform.mockReturnValue('extension');
    mockGetProtectors.mockResolvedValue({ hardware: false, password: true });
    mockVerify.mockResolvedValue(undefined);
  });

  it('verifies a desktop hardware challenge only after confirmation', async () => {
    mockGetPlatform.mockReturnValue('desktop');
    mockGetProtectors.mockResolvedValue({ hardware: true, password: false });
    const onResult = jest.fn();
    render(<StrictActionAuthentication reason="Confirm this action" onResult={onResult} />);

    fireEvent.click(await screen.findByRole('button', { name: 'continue' }));

    await waitFor(() => expect(mockVerify).toHaveBeenCalledWith(undefined));
    expect(onResult).toHaveBeenCalledWith('authenticated');
  });

  it('submits a mobile passcode and never exposes it through the result', async () => {
    mockGetPlatform.mockReturnValue('mobile');
    const onResult = jest.fn();
    render(<StrictActionAuthentication reason="Confirm this action" onResult={onResult} />);

    fireEvent.click(await screen.findByRole('button', { name: 'enter-passcode' }));

    await waitFor(() => expect(mockVerify).toHaveBeenCalledWith('123456'));
    expect(onResult).toHaveBeenCalledWith('authenticated');
  });

  it('clears an invalid password, reports a localized failure, and allows retry', async () => {
    mockVerify.mockRejectedValueOnce(new Error('raw invalid password'));
    const onResult = jest.fn();
    render(<StrictActionAuthentication reason="Confirm this action" onResult={onResult} />);

    const password = await screen.findByLabelText('password');
    fireEvent.change(password, { target: { value: 'wrong' } });
    fireEvent.click(screen.getByRole('button', { name: 'continue' }));

    await screen.findByRole('alert');
    expect(screen.getByRole('alert')).toHaveTextContent('smthWentWrong');
    expect(password).toHaveValue('');
    expect(onResult).not.toHaveBeenCalled();
    const retryPassword = await screen.findByLabelText('password');
    fireEvent.change(retryPassword, { target: { value: 'correct' } });
    fireEvent.click(screen.getByRole('button', { name: 'continue' }));

    await waitFor(() => expect(onResult).toHaveBeenCalledWith('authenticated'));
    expect(mockVerify).toHaveBeenNthCalledWith(1, 'wrong');
    expect(mockVerify).toHaveBeenNthCalledWith(2, 'correct');
  });

  it('returns cancelled from the explicit cancel action', async () => {
    const onResult = jest.fn();
    render(<StrictActionAuthentication reason="Confirm this action" onResult={onResult} />);

    fireEvent.click(await screen.findByRole('button', { name: 'cancel' }));

    expect(onResult).toHaveBeenCalledWith('cancelled');
    expect(mockVerify).not.toHaveBeenCalled();
  });

  it('suppresses a verification completion after unmount', async () => {
    mockGetPlatform.mockReturnValue('desktop');
    mockGetProtectors.mockResolvedValue({ hardware: true, password: false });
    const verification = deferred();
    mockVerify.mockReturnValue(verification.promise);
    const onResult = jest.fn();
    const view = render(<StrictActionAuthentication reason="Confirm this action" onResult={onResult} />);
    fireEvent.click(await screen.findByRole('button', { name: 'continue' }));
    await waitFor(() => expect(mockVerify).toHaveBeenCalled());

    view.unmount();
    await act(async () => verification.resolve());

    expect(onResult).not.toHaveBeenCalled();
  });

  it('fails closed when protector discovery is unavailable', async () => {
    mockGetProtectors.mockRejectedValue(new Error('storage offline'));
    const onResult = jest.fn();
    render(<StrictActionAuthentication reason="Confirm this action" onResult={onResult} />);

    expect(await screen.findByRole('alert')).toHaveTextContent('guardianAuthenticationUnavailable');
    expect(mockVerify).not.toHaveBeenCalled();
    expect(onResult).not.toHaveBeenCalled();
  });
});
