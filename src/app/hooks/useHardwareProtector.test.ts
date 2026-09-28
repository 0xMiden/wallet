import { renderHook, waitFor } from '@testing-library/react';

import { useHardwareProtector } from './useHardwareProtector';

const mockProbeHardwareProtector = jest.fn();
jest.mock('lib/miden/back/protector-probe', () => ({
  probeHardwareProtector: () => mockProbeHardwareProtector()
}));

let warn: jest.SpyInstance;

beforeEach(() => {
  jest.clearAllMocks();
  warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  warn.mockRestore();
});

it('reports no answer and no failure while the probe is pending', () => {
  mockProbeHardwareProtector.mockReturnValue(new Promise<boolean>(() => {}));
  const { result } = renderHook(() => useHardwareProtector());

  expect(result.current).toEqual({ hasHardwareProtector: null, probeFailed: false });
});

it.each([true, false])('adopts the probe answer (%s)', async hasHardware => {
  mockProbeHardwareProtector.mockResolvedValue(hasHardware);
  const { result } = renderHook(() => useHardwareProtector());

  await waitFor(() => expect(result.current).toEqual({ hasHardwareProtector: hasHardware, probeFailed: false }));
  expect(warn).not.toHaveBeenCalled();
});

// A failed probe must leave the answer unknown: `false` would pick the password gate.
it('flags a failed probe, logs it, and never answers a credential', async () => {
  mockProbeHardwareProtector.mockRejectedValue(new Error('both protector reads failed (hardware: a; password: b)'));
  const { result } = renderHook(() => useHardwareProtector());

  await waitFor(() => expect(result.current.probeFailed).toBe(true));
  expect(result.current.hasHardwareProtector).toBeNull();
  expect(warn).toHaveBeenCalledWith(expect.stringContaining('both protector reads failed (hardware: a; password: b)'));
});

// The error tells the user to reopen the page, so a new mount must probe again rather than reuse the failure.
it('probes again on a new mount after a failure', async () => {
  mockProbeHardwareProtector
    .mockRejectedValueOnce(new Error('both protector reads failed'))
    .mockResolvedValueOnce(true);
  const first = renderHook(() => useHardwareProtector());
  await waitFor(() => expect(first.result.current.probeFailed).toBe(true));
  first.unmount();

  const second = renderHook(() => useHardwareProtector());

  await waitFor(() => expect(second.result.current).toEqual({ hasHardwareProtector: true, probeFailed: false }));
  expect(mockProbeHardwareProtector).toHaveBeenCalledTimes(2);
});
