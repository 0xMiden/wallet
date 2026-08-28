import '../../../test/jest-mocks';

import React from 'react';

import { fireEvent, render, screen, waitFor } from '@testing-library/react';

import { useWalletStore } from 'lib/store';
import { WalletType } from 'screens/onboarding/types';

import { GuardianNeedsUrlBanner } from './GuardianNeedsUrlBanner';

jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key })
}));

const baseAccount = {
  publicKey: 'pk1',
  name: 'Account 1',
  isPublic: true,
  type: WalletType.Guardian,
  hdIndex: 0
};

describe('GuardianNeedsUrlBanner', () => {
  const mockApply = jest.fn();

  beforeEach(() => {
    mockApply.mockReset();
    useWalletStore.setState({
      currentAccount: { ...baseAccount, guardianSyncStatus: 'needs-user-input' },
      applyUserGuardianEndpoint: mockApply
    });
  });

  const getUrlInput = () => screen.getByPlaceholderText('guardianEndpoint') as HTMLInputElement;
  const getSubmitButton = () => screen.getByRole('button');

  it('renders nothing when guardianSyncStatus is not needs-user-input', () => {
    useWalletStore.setState({ currentAccount: { ...baseAccount, guardianSyncStatus: 'in-sync' } });
    const { container } = render(<GuardianNeedsUrlBanner />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing when guardianSyncStatus is undefined', () => {
    useWalletStore.setState({ currentAccount: { ...baseAccount, guardianSyncStatus: undefined } });
    const { container } = render(<GuardianNeedsUrlBanner />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders the prompt when guardianSyncStatus is needs-user-input', () => {
    render(<GuardianNeedsUrlBanner />);
    expect(screen.getByText('guardianChangedTitle')).toBeInTheDocument();
    expect(screen.getByText('guardianChangedBody')).toBeInTheDocument();
  });

  it('rejects an invalid URL without calling the apply action', () => {
    render(<GuardianNeedsUrlBanner />);
    fireEvent.change(getUrlInput(), { target: { value: 'not-a-url' } });
    fireEvent.click(getSubmitButton());

    expect(mockApply).not.toHaveBeenCalled();
    expect(screen.getByText('invalidUrl')).toBeInTheDocument();
  });

  it('sanitizes and applies a valid URL, calling the store action with the account public key', async () => {
    mockApply.mockResolvedValueOnce(true);
    render(<GuardianNeedsUrlBanner />);
    fireEvent.change(getUrlInput(), { target: { value: '  https://mine.example.com/  ' } });
    fireEvent.click(getSubmitButton());

    await waitFor(() => expect(mockApply).toHaveBeenCalledWith('pk1', 'https://mine.example.com'));
  });

  it('shows a mismatch error when the endpoint fails on-chain verification', async () => {
    mockApply.mockResolvedValueOnce(false);
    render(<GuardianNeedsUrlBanner />);
    fireEvent.change(getUrlInput(), { target: { value: 'https://wrong.example.com' } });
    fireEvent.click(getSubmitButton());

    await waitFor(() => expect(screen.getByText('guardianUrlMismatch')).toBeInTheDocument());
  });

  it('surfaces a thrown error message from the apply action', async () => {
    mockApply.mockRejectedValueOnce(new Error('network down'));
    render(<GuardianNeedsUrlBanner />);
    fireEvent.change(getUrlInput(), { target: { value: 'https://mine.example.com' } });
    fireEvent.click(getSubmitButton());

    await waitFor(() => expect(screen.getByText('network down')).toBeInTheDocument());
  });

  it('surfaces a stringified message when a non-Error value is thrown', async () => {
    mockApply.mockRejectedValueOnce('boom');
    render(<GuardianNeedsUrlBanner />);
    fireEvent.change(getUrlInput(), { target: { value: 'https://mine.example.com' } });
    fireEvent.click(getSubmitButton());

    await waitFor(() => expect(screen.getByText('boom')).toBeInTheDocument());
  });

  // `applyUserGuardianEndpoint` crosses the intercom boundary, which may
  // serialize the rejection: an Error arrives as a plain object carrying
  // `message` (no prototype), and some rejections carry no message at all.
  it('surfaces the message from a serialized rejection that lost its prototype', async () => {
    mockApply.mockRejectedValueOnce({ message: 'endpoint refused' });
    render(<GuardianNeedsUrlBanner />);
    fireEvent.change(getUrlInput(), { target: { value: 'https://mine.example.com' } });
    fireEvent.click(getSubmitButton());

    await waitFor(() => expect(screen.getByText('endpoint refused')).toBeInTheDocument());
  });

  it('falls back to localized copy rather than rendering [object Object]', async () => {
    mockApply.mockRejectedValueOnce({ code: 'transport_failed' });
    render(<GuardianNeedsUrlBanner />);
    fireEvent.change(getUrlInput(), { target: { value: 'https://mine.example.com' } });
    fireEvent.click(getSubmitButton());

    await waitFor(() => expect(screen.getByText('smthWentWrong')).toBeInTheDocument());
    expect(screen.queryByText('[object Object]')).not.toBeInTheDocument();
  });

  // This line is the only feedback the recovery path has, and it appears after a
  // submit rather than at render — without a live region it is silence.
  it('announces the error to assistive technology', async () => {
    mockApply.mockRejectedValueOnce(new Error('network down'));
    render(<GuardianNeedsUrlBanner />);
    fireEvent.change(getUrlInput(), { target: { value: 'https://mine.example.com' } });
    fireEvent.click(getSubmitButton());

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('network down'));
  });

  it('disables the submit button while a request is in flight, blocking re-clicks', async () => {
    let resolveApply: (value: boolean) => void = () => {};
    mockApply.mockReturnValueOnce(
      new Promise<boolean>(resolve => {
        resolveApply = resolve;
      })
    );
    render(<GuardianNeedsUrlBanner />);
    fireEvent.change(getUrlInput(), { target: { value: 'https://mine.example.com' } });
    fireEvent.click(getSubmitButton());

    expect(getSubmitButton()).toBeDisabled();
    fireEvent.click(getSubmitButton());
    expect(mockApply).toHaveBeenCalledTimes(1);

    resolveApply(true);
    await waitFor(() => expect(getSubmitButton()).not.toBeDisabled());
  });

  it('blurs the URL field on Enter (and ignores other keys) so the Done key dismisses the keyboard', () => {
    render(<GuardianNeedsUrlBanner />);
    const input = getUrlInput();

    input.focus();
    fireEvent.keyDown(input, { key: 'a' });
    expect(document.activeElement).toBe(input); // non-Enter key: no blur

    fireEvent.keyDown(input, { key: 'Enter' });
    expect(document.activeElement).not.toBe(input); // Enter: blurs
  });
});
