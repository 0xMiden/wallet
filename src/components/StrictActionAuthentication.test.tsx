import React from 'react';

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';

import { reportUserVisibleError } from 'lib/telemetry/user-visible-error';

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
  useTranslation: () => ({
    t: (key: string) =>
      ['smthWentWrong', 'biometricFailed', 'guardianAuthenticationUnavailable'].includes(key) ? `Visible ${key}` : key
  })
}));

jest.mock('lib/store', () => ({
  useWalletStore: (selector: (state: unknown) => unknown) =>
    selector({
      getStrictAuthenticationProtectors: mockGetProtectors,
      verifyStrictActionAuthentication: mockVerify
    })
}));

jest.mock('lib/mobile/haptics', () => ({ hapticLight: jest.fn(), hapticError: jest.fn() }));

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

    await screen.findByTestId('passcode-entry');
    '123456'.split('').forEach(digit => fireEvent.click(screen.getByTestId(`numpad-${digit}`)));

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

  it('ignores a submit with no password entered', async () => {
    const onResult = jest.fn();
    render(<StrictActionAuthentication reason="Confirm this action" onResult={onResult} />);

    await screen.findByLabelText('password');
    fireEvent.click(screen.getByRole('button', { name: 'continue' }));

    // No verification attempt at all: an empty submit is a mis-click, not a wrong password, and
    // counting it would spend an attempt and clear the field for nothing.
    await waitFor(() => expect(mockGetProtectors).toHaveBeenCalled());
    expect(mockVerify).not.toHaveBeenCalled();
    expect(onResult).not.toHaveBeenCalled();
  });

  it('names the biometric failure and relabels the action as a retry', async () => {
    mockGetPlatform.mockReturnValue('desktop');
    mockGetProtectors.mockResolvedValue({ hardware: true, password: false });
    mockVerify.mockRejectedValueOnce(new Error('sensor said no'));
    render(<StrictActionAuthentication reason="Confirm this action" onResult={jest.fn()} />);

    fireEvent.click(await screen.findByRole('button', { name: 'continue' }));

    // A hardware rejection must not read as a generic wallet error; the user needs to know it was
    // the biometric check that refused, and the action needs to invite another attempt.
    expect(await screen.findByRole('alert')).toHaveTextContent('biometricFailed');
    expect(screen.getByRole('button', { name: 'tryAgain' })).toBeInTheDocument();
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

jest.mock('lib/telemetry/user-visible-error', () => ({
  ...jest.requireActual('lib/telemetry/user-visible-error'),
  reportUserVisibleError: jest.fn()
}));

const mockReport = jest.mocked(reportUserVisibleError);

describe('user-visible strict-authentication errors', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.clearAllMocks();
    mockGetPlatform.mockReturnValue('extension');
    mockGetProtectors.mockResolvedValue({ hardware: false, password: true });
    mockVerify.mockResolvedValue(undefined);
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  const dwell = () => {
    act(() => jest.advanceTimersByTime(999));
    expect(mockReport.mock.calls).toEqual([]);
    act(() => jest.advanceTimersByTime(1));
  };
  const passwordAttempt = async () => {
    fireEvent.change(screen.getByLabelText('password'), { target: { value: 'private password' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'continue' }));
    });
  };

  it('reports one error once when a wrong passcode is visible in ErrorLine and real PasscodeEntry', async () => {
    mockGetPlatform.mockReturnValue('mobile');
    mockVerify.mockRejectedValueOnce(new Error('private passcode rejection'));
    render(<StrictActionAuthentication reason="Approve action" onResult={jest.fn()} />);
    await act(async () => {});
    '123456'.split('').forEach(digit => fireEvent.click(screen.getByTestId(`numpad-${digit}`)));
    await act(async () => {
      jest.advanceTimersByTime(150);
    });
    expect(screen.getByRole('alert')).toHaveTextContent('Visible smthWentWrong');
    expect(screen.getByTestId('passcode-entry')).toHaveTextContent('Visible smthWentWrong');
    expect(screen.getAllByText('Visible smthWentWrong')).toHaveLength(2);
    dwell();
    expect(mockReport.mock.calls).toEqual([['smthWentWrong', 'inline']]);
    act(() => jest.advanceTimersByTime(1000));
    expect(mockReport.mock.calls).toEqual([['smthWentWrong', 'inline']]);
  });

  it('reports the password failure using its fixed key rather than the rejected credential or raw cause', async () => {
    mockVerify.mockRejectedValueOnce(new Error('private password cause'));
    render(<StrictActionAuthentication reason="Approve action" onResult={jest.fn()} />);
    await act(async () => {});
    await passwordAttempt();
    expect(screen.getByRole('alert')).toHaveTextContent('Visible smthWentWrong');
    dwell();
    expect(mockReport.mock.calls).toEqual([['smthWentWrong', 'inline']]);
    act(() => jest.advanceTimersByTime(1000));
    expect(mockReport.mock.calls).toEqual([['smthWentWrong', 'inline']]);
  });

  it('reports biometricFailed after a hardware rejection is visible for 1000 ms', async () => {
    mockGetPlatform.mockReturnValue('desktop');
    mockGetProtectors.mockResolvedValue({ hardware: true, password: false });
    mockVerify.mockRejectedValueOnce(new Error('private hardware cause'));
    render(<StrictActionAuthentication reason="Approve action" onResult={jest.fn()} />);
    await act(async () => {});
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'continue' }));
    });
    expect(screen.getByRole('alert')).toHaveTextContent('Visible biometricFailed');
    dwell();
    expect(mockReport.mock.calls).toEqual([['biometricFailed', 'inline']]);
    act(() => jest.advanceTimersByTime(1000));
    expect(mockReport.mock.calls).toEqual([['biometricFailed', 'inline']]);
  });

  it('reports guardianAuthenticationUnavailable when protector discovery fails', async () => {
    mockGetProtectors.mockRejectedValueOnce(new Error('private discovery cause'));
    render(<StrictActionAuthentication reason="Approve action" onResult={jest.fn()} />);
    await act(async () => {});
    expect(screen.getByRole('alert')).toHaveTextContent('Visible guardianAuthenticationUnavailable');
    dwell();
    expect(mockReport.mock.calls).toEqual([['guardianAuthenticationUnavailable', 'inline']]);
    act(() => jest.advanceTimersByTime(1000));
    expect(mockReport.mock.calls).toEqual([['guardianAuthenticationUnavailable', 'inline']]);
  });

  it('does not report loading, idle password entry, pending verification, or success', async () => {
    let ready!: (value: { hardware: boolean; password: boolean }) => void;
    mockGetProtectors.mockReturnValueOnce(
      new Promise(resolve => {
        ready = resolve;
      })
    );
    const verification = deferred();
    mockVerify.mockReturnValueOnce(verification.promise);
    const onResult = jest.fn();
    render(<StrictActionAuthentication reason="Approve action" onResult={onResult} />);
    expect(screen.getByRole('status')).toHaveTextContent('loading');
    act(() => jest.advanceTimersByTime(1000));
    await act(async () => {
      ready({ hardware: false, password: true });
    });
    expect(screen.getByLabelText('password')).toBeInTheDocument();
    act(() => jest.advanceTimersByTime(1000));
    await passwordAttempt();
    expect(screen.getByRole('button', { name: 'continue' })).toBeDisabled();
    act(() => jest.advanceTimersByTime(1000));
    await act(async () => {
      verification.resolve();
    });
    expect(onResult).toHaveBeenCalledWith('authenticated');
    act(() => jest.advanceTimersByTime(1000));
    expect(mockReport.mock.calls).toEqual([]);
  });

  it('drops both wrong-passcode displays when a new digit clears the error at 999 ms', async () => {
    mockGetPlatform.mockReturnValue('mobile');
    mockVerify.mockRejectedValueOnce(new Error('private passcode cause'));
    render(<StrictActionAuthentication reason="Approve action" onResult={jest.fn()} />);
    await act(async () => {});
    '123456'.split('').forEach(digit => fireEvent.click(screen.getByTestId(`numpad-${digit}`)));
    await act(async () => {
      jest.advanceTimersByTime(150);
    });
    expect(screen.getAllByText('Visible smthWentWrong')).toHaveLength(2);
    act(() => jest.advanceTimersByTime(999));
    fireEvent.click(screen.getByTestId('numpad-7'));
    expect(screen.queryByText('Visible smthWentWrong')).not.toBeInTheDocument();
    act(() => jest.advanceTimersByTime(1000));
    expect(mockReport.mock.calls).toEqual([]);
  });

  it('drops a password failure removed by host cancellation before dwell', async () => {
    mockVerify.mockRejectedValueOnce(new Error('private failure'));
    const onResult = jest.fn();
    const view = render(<StrictActionAuthentication reason="Approve action" onResult={onResult} />);
    await act(async () => {});
    await passwordAttempt();
    expect(screen.getByRole('alert')).toBeInTheDocument();
    act(() => jest.advanceTimersByTime(999));
    fireEvent.click(screen.getByRole('button', { name: 'cancel' }));
    expect(onResult).toHaveBeenCalledWith('cancelled');
    view.unmount();
    act(() => jest.advanceTimersByTime(1000));
    expect(mockReport.mock.calls).toEqual([]);
  });
});

describe('Task5 recovery authenticated action component', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetPlatform.mockReturnValue('desktop');
    mockGetProtectors.mockResolvedValue({ hardware: true, password: false });
    mockVerify.mockResolvedValue(undefined);
  });

  it('submits the typed backend operation once without prompting for verification first', async () => {
    const action = jest.fn().mockResolvedValue(undefined);
    const onResult = jest.fn();
    render(
      <StrictActionAuthentication
        reason="Disposable recovery operation"
        authenticatedAction={action}
        onResult={onResult}
      />
    );
    fireEvent.click(await screen.findByRole('button', { name: 'continue' }));
    await waitFor(() => expect(action).toHaveBeenCalledTimes(1));
    expect(action).toHaveBeenCalledWith(undefined);
    expect(mockVerify).not.toHaveBeenCalled();
    expect(onResult).toHaveBeenCalledWith('authenticated');
  });

  it('discards completion after unmount while keeping one operation in flight', async () => {
    const work = deferred();
    const action = jest.fn(() => work.promise);
    const onResult = jest.fn();
    const view = render(
      <StrictActionAuthentication
        reason="Disposable recovery operation"
        authenticatedAction={action}
        onResult={onResult}
      />
    );
    fireEvent.click(await screen.findByRole('button', { name: 'continue' }));
    await waitFor(() => expect(action).toHaveBeenCalledTimes(1));
    view.unmount();
    await act(async () => {
      work.resolve();
    });
    expect(onResult).not.toHaveBeenCalled();
    expect(mockVerify).not.toHaveBeenCalled();
  });
});
