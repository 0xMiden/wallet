jest.mock('lib/remote-config/runtime', () => ({
  getBridgeConfigSnapshot: () =>
    jest
      .requireActual<typeof import('lib/remote-config/testing/fixture')>('lib/remote-config/testing/fixture')
      .testBridgeSnapshot()
}));

import { createHash } from 'crypto';
import { readFileSync } from 'fs';
import { join } from 'path';
import { Hex, isHex } from 'viem';

import {
  decodeXReserveDepositIntent,
  fetchXReserveAttestations,
  findAttestationForDomain,
  matchUsdcxDepositAttestation,
  UsdcxDepositExpectation,
  XReserveAttestation
} from './attestation';
import vectors from './attestation.vectors.json';
import { getUsdcxRemoteDomain, getUsdcxAttestationUrl } from './constant';

const fetchMock = jest.fn();
Object.defineProperty(globalThis, 'fetch', { value: fetchMock, writable: true, configurable: true });

const TX_HASH = `0x${'a'.repeat(64)}` as const;

const entry = (overrides: Record<string, unknown> = {}) => ({
  payload: '0x1234',
  messageHash: `0x${'b'.repeat(64)}`,
  attestation: '0xabcd',
  remoteDomain: 10001,
  ...overrides
});

const okResponse = (body: unknown) => ({ ok: true, status: 200, json: async () => body });

beforeEach(() => {
  jest.clearAllMocks();
  jest.useRealTimers();
});

describe('fetchXReserveAttestations', () => {
  it('queries the attestations endpoint by transaction hash', async () => {
    fetchMock.mockResolvedValue(okResponse({ attestations: [] }));

    await fetchXReserveAttestations(TX_HASH);

    expect(fetchMock).toHaveBeenCalledWith(
      `${getUsdcxAttestationUrl()}/v1/attestations?txHash=${TX_HASH}`,
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    );
  });

  it('accepts a custom base URL', async () => {
    fetchMock.mockResolvedValue(okResponse({ attestations: [] }));

    await fetchXReserveAttestations(TX_HASH, { baseUrl: 'https://example.test' });

    expect(fetchMock.mock.calls[0][0]).toBe(`https://example.test/v1/attestations?txHash=${TX_HASH}`);
  });

  // Circle answers an unknown or not-yet-signed hash with HTTP 200 and an empty list.
  it('returns an empty list before Circle signs', async () => {
    fetchMock.mockResolvedValue(okResponse({ attestations: [] }));

    await expect(fetchXReserveAttestations(TX_HASH)).resolves.toEqual([]);
  });

  it('parses a signed attestation', async () => {
    fetchMock.mockResolvedValue(okResponse({ attestations: [entry()] }));

    await expect(fetchXReserveAttestations(TX_HASH)).resolves.toEqual([entry()]);
  });

  it('accepts a numeric-string remote domain', async () => {
    fetchMock.mockResolvedValue(okResponse({ attestations: [entry({ remoteDomain: '10007' })] }));

    const parsed = await fetchXReserveAttestations(TX_HASH);
    expect(parsed.map(entry => entry.remoteDomain)).toEqual([10007]);
  });

  it.each([
    ['a non-hex payload', entry({ payload: 'nope' })],
    ['a missing signature', entry({ attestation: undefined })],
    ['an empty signature', entry({ attestation: '0x' })],
    ['an empty payload', entry({ payload: '0x' })],
    ['a non-numeric domain', entry({ remoteDomain: 'canton' })],
    ['a non-object entry', 'garbage']
  ])('drops an entry with %s', async (_label, malformed) => {
    fetchMock.mockResolvedValue(okResponse({ attestations: [malformed, entry()] }));

    await expect(fetchXReserveAttestations(TX_HASH)).resolves.toEqual([entry()]);
  });

  it('returns an empty list when the body has no attestations array', async () => {
    fetchMock.mockResolvedValue(okResponse({}));

    await expect(fetchXReserveAttestations(TX_HASH)).resolves.toEqual([]);
  });

  it('throws on a non-OK response', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 500, json: async () => ({}) });

    await expect(fetchXReserveAttestations(TX_HASH)).rejects.toThrow('HTTP 500');
  });

  it('aborts when headers arrive but the response body stops', async () => {
    jest.useFakeTimers();
    fetchMock.mockImplementation(async (_url: string, init: { signal: AbortSignal }) => ({
      ok: true,
      json: () =>
        new Promise((_resolve, reject) => {
          init.signal.addEventListener('abort', () => reject(new Error('aborted')));
        })
    }));

    const pending = fetchXReserveAttestations(TX_HASH, { timeoutMs: 1000 });
    await Promise.all([expect(pending).rejects.toThrow('aborted'), jest.advanceTimersByTimeAsync(1000)]);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('aborts a request that never answers', async () => {
    jest.useFakeTimers();
    fetchMock.mockImplementation(
      (_url: string, init: { signal: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          init.signal.addEventListener('abort', () => reject(new Error('aborted')));
        })
    );

    const pending = fetchXReserveAttestations(TX_HASH, { timeoutMs: 1000 });
    jest.advanceTimersByTime(1000);
    await expect(pending).rejects.toThrow('aborted');
  });
});

describe('findAttestationForDomain', () => {
  const list: XReserveAttestation[] = [
    { payload: '0x01', messageHash: `0x${'1'.repeat(64)}`, attestation: '0x0a', remoteDomain: 10001 },
    { payload: '0x02', messageHash: `0x${'2'.repeat(64)}`, attestation: '0x0b', remoteDomain: 10007 }
  ];

  it('returns the attestation for the requested domain', () => {
    expect(findAttestationForDomain(list, 10007)?.payload).toBe('0x02');
  });

  it('ignores attestations for other domains', () => {
    expect(findAttestationForDomain(list, 10005)).toBeUndefined();
  });
});

function hexOf(value: string | undefined): Hex {
  if (value === undefined || !isHex(value)) throw new Error(`not hex: ${value}`);
  return value;
}

// Circle's answer for deposit 0x370bf19a (attestation.vectors.json): 2000 USDC from Arc Testnet to Miden account
// 0x8da911727d5b53916f2c221c00c091, minted as the USDCx faucet 0x4cbdcaffe75f0a317482224dae6436.
const CAPTURED_PAYLOAD = hexOf(vectors.attestations[0]?.payload);
const ACCOUNT_RECIPIENT: Hex = '0x000000000000000000000000000000008da911727d5b53916f2c221c00c09100';
const USDCX_TOKEN: Hex = '0x000000000000000000000000000000004cbdcaffe75f0a317482224dae643600';

/** `payload` with the bytes at `offset` replaced by `hex` (no 0x prefix), so one field changes at a time. */
const withBytes = (offset: number, hex: string, payload: Hex = CAPTURED_PAYLOAD): Hex =>
  `0x${payload.slice(2, 2 + offset * 2)}${hex}${payload.slice(2 + offset * 2 + hex.length)}`;

describe('decodeXReserveDepositIntent', () => {
  it('reads every field of the captured deposit', () => {
    expect(decodeXReserveDepositIntent(CAPTURED_PAYLOAD)).toEqual({
      version: 1,
      amount: 2_000_000_000n,
      remoteDomain: 10007,
      remoteToken: USDCX_TOKEN,
      remoteRecipient: ACCOUNT_RECIPIENT,
      localToken: '0x0000000000000000000000003600000000000000000000000000000000000000',
      localDepositor: '0x000000000000000000000000e88f781e6cc8b7496f259200b57e22cb9457ff99',
      maxFee: 0n,
      nonce: '0x335d432e805b61478619eced3af4f3d074e217df74d49eb797542275318e8a41',
      hookData: '0x'
    });
  });

  it('reads the hook data its length names, in lower case', () => {
    const hooked = withBytes(236, '00000002', `${CAPTURED_PAYLOAD}ABCD`);

    expect(decodeXReserveDepositIntent(hooked)?.hookData).toBe('0xabcd');
  });

  it.each<[string, Hex]>([
    ['another magic', withBytes(0, '5a2e0acc')],
    ['version 2', withBytes(4, '00000002')],
    ['one byte too many', `${CAPTURED_PAYLOAD}00`],
    ['one byte too few', hexOf(CAPTURED_PAYLOAD.slice(0, -2))],
    ['a hook length the payload does not carry', withBytes(236, '00000001')],
    ['a header cut short', hexOf(CAPTURED_PAYLOAD.slice(0, 2 + 236 * 2))],
    ['half a byte', `${CAPTURED_PAYLOAD}0`]
  ])('reads nothing from a payload with %s', (_label, payload) => {
    expect(decodeXReserveDepositIntent(payload)).toBeUndefined();
  });
});

// Two older deposits Circle attested (0x908904ec and 0xb4dce6ec, read 2026-10-10) name the previous USDCx faucet
// 0x179f749ee2329e317d96fe3ed5aaf9 and a recipient no Miden account id encodes to: an id missing its trailing zero
// byte, and a suffix whose low byte is not zero. Each payload here carries their token, recipient and amount.
const OLD_TOKEN: Hex = '0x00000000000000000000000000000000179f749ee2329e317d96fe3ed5aaf900';
const oldDeposit = (recipient: string, amount: string): Hex =>
  withBytes(8, amount.padStart(64, '0'), withBytes(44, OLD_TOKEN.slice(2), withBytes(76, recipient)));
const PAYLOAD_908904EC = oldDeposit('00000000000000000000000000000000009f2331d6b181dd5170cd318bdcd601', 'f4240');
const PAYLOAD_B4DCE6EC = oldDeposit('0000000000000000000000000000000088363e3c54d0c6d10031a96e54ceed80', '3b9aca00');

const attestationOf = (payload: Hex, remoteDomain = getUsdcxRemoteDomain()): XReserveAttestation => ({
  payload,
  messageHash: `0x${'1'.repeat(64)}`,
  attestation: '0xabcd',
  remoteDomain
});
const CAPTURED = attestationOf(CAPTURED_PAYLOAD);
const expected = (overrides: Partial<UsdcxDepositExpectation> = {}): UsdcxDepositExpectation => ({
  remoteRecipient: ACCOUNT_RECIPIENT,
  remoteToken: USDCX_TOKEN,
  amount: 2_000_000_000n,
  ...overrides
});

describe('matchUsdcxDepositAttestation', () => {
  it('attests a deposit whose amount, recipient, token and domain all match, comparing hex in any case', () => {
    const upper: Hex = `0x${ACCOUNT_RECIPIENT.slice(2).toUpperCase()}`;

    expect(matchUsdcxDepositAttestation([CAPTURED], expected({ remoteRecipient: upper }))).toEqual({
      kind: 'attested',
      attestation: CAPTURED,
      intent: decodeXReserveDepositIntent(CAPTURED_PAYLOAD)
    });
  });

  it('waits while Circle has attested nothing', () => {
    expect(matchUsdcxDepositAttestation([], expected())).toEqual({ kind: 'pending' });
  });

  it.each<[string, XReserveAttestation[], UsdcxDepositExpectation, string]>([
    ['an attestation for Canton (10001) only', [attestationOf(CAPTURED_PAYLOAD, 10001)], expected(), 'remoteDomain'],
    [
      'a payload naming another domain than its entry',
      [attestationOf(withBytes(40, '00002711'))],
      expected(),
      'remoteDomain'
    ],
    ['another token', [CAPTURED], expected({ remoteToken: OLD_TOKEN }), 'remoteToken'],
    ['another Miden account', [CAPTURED], expected({ remoteRecipient: USDCX_TOKEN }), 'recipient'],
    ['another amount', [CAPTURED], expected({ amount: 1_999_999_999n }), 'amount'],
    ['the previous USDCx faucet', [attestationOf(PAYLOAD_908904EC)], expected({ amount: 1_000_000n }), 'remoteToken'],
    [
      'a recipient missing its trailing zero byte (0x908904ec)',
      [attestationOf(PAYLOAD_908904EC)],
      expected({
        remoteToken: OLD_TOKEN,
        remoteRecipient: '0x000000000000000000000000000000009f2331d6b181dd5170cd318bdcd60100',
        amount: 1_000_000n
      }),
      'recipient'
    ],
    [
      'a recipient whose suffix ends in a non-zero byte (0xb4dce6ec)',
      [attestationOf(PAYLOAD_B4DCE6EC)],
      expected({
        remoteToken: OLD_TOKEN,
        remoteRecipient: '0x0000000000000000000000000000000088363e3c54d0c6d10031a96e54ceed00',
        amount: 1_000_000_000n
      }),
      'recipient'
    ],
    [
      'a payload that differs in domain and recipient',
      [attestationOf(withBytes(40, '00002711'))],
      expected({ remoteRecipient: USDCX_TOKEN }),
      'remoteDomain'
    ],
    [
      'a deposit that differs in token and recipient',
      [CAPTURED],
      expected({ remoteToken: OLD_TOKEN, remoteRecipient: USDCX_TOKEN }),
      'remoteToken'
    ],
    [
      'a recipient mismatch beside an entry for another domain',
      [attestationOf(CAPTURED_PAYLOAD, 10001), CAPTURED],
      expected({ remoteRecipient: USDCX_TOKEN }),
      'recipient'
    ]
  ])('names the first field that differs for %s', (_label, list, expectation, field) => {
    expect(matchUsdcxDepositAttestation(list, expectation)).toEqual({ kind: 'mismatch', field });
  });

  it.each<[string, Hex]>([
    ['another magic', withBytes(0, '5a2e0acc')],
    ['version 2', withBytes(4, '00000002')],
    ['one byte too many', `${CAPTURED_PAYLOAD}00`],
    ['one byte too few', hexOf(CAPTURED_PAYLOAD.slice(0, -2))]
  ])('cannot read an entry for Miden with %s', (_label, payload) => {
    expect(matchUsdcxDepositAttestation([attestationOf(payload)], expected())).toEqual({ kind: 'unreadable' });
  });

  it('attests a matching entry beside a mismatching one, in either order', () => {
    const other = attestationOf(withBytes(76, ACCOUNT_RECIPIENT.slice(2).replace('8da9', '8da8')));

    expect(matchUsdcxDepositAttestation([other, CAPTURED], expected()).kind).toBe('attested');
    expect(matchUsdcxDepositAttestation([CAPTURED, other], expected()).kind).toBe('attested');
  });

  it('reports an unreadable entry over a mismatching one', () => {
    const unreadable = attestationOf(withBytes(0, '5a2e0acc'));

    expect(matchUsdcxDepositAttestation([CAPTURED, unreadable], expected({ amount: 1n }))).toEqual({
      kind: 'unreadable'
    });
  });

  it('compares neither the fee, the hook data nor the depositor', () => {
    const fee = withBytes(172, `${'0'.repeat(56)}000f4240`);
    const depositor = withBytes(140, `${'0'.repeat(24)}${'1'.repeat(40)}`, fee);
    const hooked = withBytes(236, '00000002', `${depositor}abcd`);

    expect(matchUsdcxDepositAttestation([attestationOf(hooked)], expected()).kind).toBe('attested');
  });

  it("matches the domain the caller names, the payload's as well as the entry's", () => {
    const canton = attestationOf(withBytes(40, '00002711'), 10001);

    expect(matchUsdcxDepositAttestation([canton], expected({ remoteDomain: 10001 })).kind).toBe('attested');
    expect(matchUsdcxDepositAttestation([canton], expected())).toEqual({ kind: 'mismatch', field: 'remoteDomain' });
  });
});

// The capture is Circle's answer byte for byte: no formatter may touch it (.prettierignore lists it).
describe('attestation.vectors.json', () => {
  it('stays byte for byte the body Circle served for 0x370bf19a', () => {
    const file = readFileSync(join(__dirname, 'attestation.vectors.json'));
    expect(createHash('sha256').update(file).digest('hex')).toBe(
      '7be79c54f853248d2ebf8c1f5a9a65be1701b68b97c99545fe2df43d72843e0f'
    );
  });
});
