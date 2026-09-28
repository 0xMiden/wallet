import { act, renderHook } from '@testing-library/react';

import { fetchXReserveAttestations, XReserveAttestation } from './attestation';
import { USDCX_REMOTE_DOMAIN } from './constant';
import { useUsdcxAttestation } from './use-attestation';

jest.mock('./attestation', () => ({
  ...jest.requireActual('./attestation'),
  fetchXReserveAttestations: jest.fn()
}));

const fetchAttestations = jest.mocked(fetchXReserveAttestations);
const HASH = `0x${'a'.repeat(64)}`;
const OTHER_HASH = `0x${'b'.repeat(64)}`;
const signed: XReserveAttestation = {
  payload: '0xab',
  messageHash: '0xcd',
  attestation: '0xef',
  remoteDomain: USDCX_REMOTE_DOMAIN
};

beforeEach(() => {
  jest.useFakeTimers();
  fetchAttestations.mockReset().mockResolvedValue([]);
});

afterEach(() => jest.useRealTimers());

it('checks immediately, then every 12 seconds, and stops after a matching attestation', async () => {
  const { result, unmount } = renderHook(() => useUsdcxAttestation(HASH, true));
  await act(async () => {});
  expect(fetchAttestations).toHaveBeenCalledWith(HASH);
  expect(result.current).toBe(false);
  await act(async () => {
    jest.advanceTimersByTime(11_999);
  });
  expect(fetchAttestations).toHaveBeenCalledTimes(1);
  fetchAttestations.mockResolvedValue([{ ...signed, remoteDomain: USDCX_REMOTE_DOMAIN + 1 }]);
  await act(async () => {
    jest.advanceTimersByTime(1);
  });
  expect(result.current).toBe(false);
  fetchAttestations.mockResolvedValue([signed]);
  await act(async () => {
    jest.advanceTimersByTime(12_000);
  });
  expect(result.current).toBe(true);
  await act(async () => {
    jest.advanceTimersByTime(24_000);
  });
  expect(fetchAttestations).toHaveBeenCalledTimes(3);
  unmount();
});

it('ignores an in-flight response after switching transactions and stops on unmount', async () => {
  let resolveOld: (value: XReserveAttestation[]) => void = () => {};
  fetchAttestations.mockReturnValueOnce(
    new Promise(resolve => {
      resolveOld = resolve;
    })
  );
  const { result, rerender, unmount } = renderHook(({ hash }) => useUsdcxAttestation(hash, true), {
    initialProps: { hash: HASH }
  });
  rerender({ hash: OTHER_HASH });
  await act(async () => {
    resolveOld([signed]);
  });
  expect(result.current).toBe(false);
  unmount();
  await act(async () => {
    jest.advanceTimersByTime(12_000);
  });
  expect(fetchAttestations).toHaveBeenCalledTimes(2);
});

it('does not poll inactive or invalid deposits', () => {
  const { rerender, unmount } = renderHook(({ hash, active }) => useUsdcxAttestation(hash, active), {
    initialProps: { hash: HASH, active: false }
  });
  rerender({ hash: 'invalid', active: true });
  expect(fetchAttestations).not.toHaveBeenCalled();
  unmount();
});
