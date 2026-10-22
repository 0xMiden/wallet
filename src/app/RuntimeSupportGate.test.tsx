import React from 'react';

import { act, render, screen } from '@testing-library/react';

import { reportUserVisibleError } from 'lib/telemetry/user-visible-error';
import { isWasmSimdSupported } from 'lib/wasm-simd';

import { RuntimeSupportGate } from './RuntimeSupportGate';

jest.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
jest.mock('lib/wasm-simd', () => ({ isWasmSimdSupported: jest.fn() }));
jest.mock('lib/telemetry/user-visible-error', () => ({
  ...jest.requireActual('lib/telemetry/user-visible-error'),
  reportUserVisibleError: jest.fn()
}));

describe('RuntimeSupportGate', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.mocked(reportUserVisibleError).mockClear();
  });
  afterEach(() => jest.useRealTimers());

  it('renders the wallet when the runtime supports WebAssembly SIMD', () => {
    jest.mocked(isWasmSimdSupported).mockReturnValue(true);
    render(<RuntimeSupportGate>Private wallet</RuntimeSupportGate>);
    expect(screen.getByText('Private wallet')).toBeVisible();
    expect(screen.queryByTestId('runtime-unsupported')).toBeNull();
    act(() => jest.advanceTimersByTime(5000));
    expect(reportUserVisibleError).not.toHaveBeenCalled();
  });

  it('shows the unsupported page instead of the wallet and reports its fixed message once', () => {
    jest.mocked(isWasmSimdSupported).mockReturnValue(false);
    render(<RuntimeSupportGate>Private wallet</RuntimeSupportGate>);
    expect(screen.getByTestId('runtime-unsupported')).toBeVisible();
    expect(screen.getByText('runtimeUnsupportedTitle')).toBeVisible();
    expect(screen.getByText('runtimeUnsupportedBody')).toBeVisible();
    expect(screen.queryByText('Private wallet')).toBeNull();
    act(() => jest.advanceTimersByTime(1000));
    expect(jest.mocked(reportUserVisibleError).mock.calls).toEqual([['runtimeUnsupportedBody', 'startup']]);
    act(() => jest.advanceTimersByTime(5000));
    expect(reportUserVisibleError).toHaveBeenCalledTimes(1);
  });
});
