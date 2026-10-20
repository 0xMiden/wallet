/** @jest-environment node */
import { optionalPublicFaucetGrant } from './public-faucet';
import { ROUNDTRIP_DEPOSIT_UNITS, roundtripBurnUnits } from './usdcx-roundtrip-funding';
import { USDCX_MIN_BURN } from '../../../src/lib/usdcx/protocol';
import { usdcxMinimumBurnShortfall } from '../../../src/lib/usdcx/withdrawal';

jest.mock('lib/remote-config/runtime', () => ({
  getBridgeConfigSnapshot: () =>
    jest
      .requireActual<typeof import('lib/remote-config/testing/fixture')>('lib/remote-config/testing/fixture')
      .testBridgeSnapshot()
}));
jest.mock('lib/miden-chain/native-asset', () => ({ getNativeAssetIdSync: () => 'mtst1native' }));
jest.mock('lib/miden/sdk/helpers', () => ({ sameWalletAccountId: (a: string, b: string) => a === b }));
jest.mock('lib/miden-chain/effective-endpoints', () => ({ getEffectiveNetworkName: () => 'testnet' }));

const NOTE_ID = `0x${'01'.repeat(32)}`;
const controller = () => new AbortController();
const challenge = () => new Response(JSON.stringify({ challenge: '01'.repeat(32), target: 2 ** 64 }));

afterEach(() => {
  jest.restoreAllMocks();
  jest.useRealTimers();
});

it('uses the deposit for a 2 USDCx burn after a faucet 503, with no grant retry', async () => {
  const fetch = jest
    .spyOn(global, 'fetch')
    .mockResolvedValueOnce(challenge())
    .mockResolvedValueOnce(new Response('Unavailable', { status: 503 }));
  const result = await optionalPublicFaucetGrant('https://faucet.example', 'account', 10_000_000n, controller().signal);
  expect(result).toEqual({ kind: 'unavailable', reason: 'Public faucet mint failed (503): Unavailable' });
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(roundtripBurnUnits(ROUNDTRIP_DEPOSIT_UNITS - 133n, false)).toBe(2_000_000n);
});

it('returns the grant note and permits a 3 USDCx burn after the grant is consumed', async () => {
  jest
    .spyOn(global, 'fetch')
    .mockResolvedValueOnce(challenge())
    .mockResolvedValueOnce(new Response(JSON.stringify({ note_id: NOTE_ID })));
  await expect(
    optionalPublicFaucetGrant('https://faucet.example', 'account', 10_000_000n, controller().signal)
  ).resolves.toEqual({ kind: 'granted', noteId: NOTE_ID });
  expect(roundtripBurnUnits(12_199_734n, true)).toBe(3_000_000n);
  expect(() => roundtripBurnUnits(2_199_867n, true)).toThrow('cannot cover');
});

it('does not treat a malformed grant as an optional service failure', async () => {
  jest
    .spyOn(global, 'fetch')
    .mockResolvedValueOnce(challenge())
    .mockResolvedValueOnce(new Response(JSON.stringify({ note_id: 'bad' })));
  await expect(
    optionalPublicFaucetGrant('https://faucet.example', 'account', 10_000_000n, controller().signal)
  ).rejects.toThrow('invalid note ID');
});

it('stops a stalled request and allows the deposit-funded burn', async () => {
  jest.useFakeTimers();
  const fetch = jest.spyOn(global, 'fetch').mockImplementation(
    (_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
      })
  );
  const result = optionalPublicFaucetGrant('https://faucet.example', 'account', 10_000_000n, controller().signal);
  await jest.advanceTimersByTimeAsync(15_000);
  await expect(result).resolves.toEqual({ kind: 'unavailable', reason: 'Request timed out after 15000 ms' });
  await jest.advanceTimersByTimeAsync(60_000);
  expect(fetch).toHaveBeenCalledTimes(1);
});

it('propagates test cancellation and makes no later funding request', async () => {
  const abort = controller();
  const fetch = jest.spyOn(global, 'fetch').mockImplementation(
    (_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
      })
  );
  const result = optionalPublicFaucetGrant('https://faucet.example', 'account', 10_000_000n, abort.signal);
  abort.abort(new Error('test cancelled'));
  await expect(result).rejects.toThrow('test cancelled');
  expect(fetch).toHaveBeenCalledTimes(1);
});

it('refuses a burn that would spend the fee reserve', () => {
  expect(() => roundtripBurnUnits(2_000_000n, false)).toThrow('cannot cover');
  expect(() => roundtripBurnUnits(3_000_000n, true)).toThrow('cannot cover');
});

it('does not wait out a rate limit for optional funding', async () => {
  const fetch = jest
    .spyOn(global, 'fetch')
    .mockResolvedValue(new Response('Account is rate limited for 59 more seconds.', { status: 429 }));
  await expect(
    optionalPublicFaucetGrant('https://faucet.example', 'account', 10_000_000n, controller().signal)
  ).resolves.toMatchObject({ kind: 'unavailable' });
  expect(fetch).toHaveBeenCalledTimes(1);
});

it('keeps invalid requests as failures', async () => {
  jest.spyOn(global, 'fetch').mockResolvedValue(new Response('Invalid amount', { status: 400 }));
  await expect(
    optionalPublicFaucetGrant('https://faucet.example', 'account', 10_000_000n, controller().signal)
  ).rejects.toThrow('Invalid amount');
});

it.each([false, true])('round-trip selector obeys the wallet minimum (grant=%s)', receivedGrant => {
  expect(USDCX_MIN_BURN).toBe(5_000_000n);
  const selected = roundtripBurnUnits(10_000_000n, receivedGrant);
  expect(usdcxMinimumBurnShortfall(selected)).toBeUndefined();
});
