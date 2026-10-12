/**
 * @jest-environment node
 */
import type { TokenBalanceData } from 'lib/miden/front/balance';
import type { BridgeToken } from 'lib/remote-config/derive';

import { resolveSellToken, SellTokenResolution } from './sell-token';

const TRNSK_SEPOLIA = '0x0c86a754a29714c4fe9c6f1359fa7099ed174c0b';
const FAUCET = 'mtst1trnsk';
const OTHER_FAUCET = 'mtst1other';

let mockTokens: BridgeToken[] | null = [];
let mockPinnedFaucet: string | undefined;
const mockInitBridgeConfig = jest.fn(async () => undefined);

jest.mock('lib/epoch/evm-account', () => ({ buildVaultEvmWalletClient: jest.fn() }));
jest.mock('lib/agglayer/allowed-faucets', () => ({ isAgglayerFaucetAllowed: jest.fn() }));
jest.mock('lib/agglayer/constant', () => ({
  TRNSK_SEPOLIA_ADDRESS: '0x0c86a754a29714c4fe9c6f1359fa7099ed174c0b',
  TRNSK_DECIMALS: 18,
  TRNSK_SYMBOL: 'TRNSK',
  get AGGLAYER_TRNSK_FAUCET_ID() {
    return mockPinnedFaucet;
  }
}));
// The registry names a faucet in hex and the balances name it in bech32. The fake SDK maps both to one id.
jest.mock('lib/miden/sdk/helpers', () => ({
  accountRefToSdk: (ref: string) => ({ toString: () => ref.replace(/^hex:/, '') })
}));
jest.mock('lib/miden-chain/constants', () => ({ ensureSdkWasmReady: jest.fn(async () => undefined) }));
jest.mock('lib/miden-chain/effective-endpoints', () => ({ getEffectiveRpcUrl: () => 'https://rpc.test' }));
jest.mock('lib/remote-config/runtime', () => ({ initBridgeConfig: () => mockInitBridgeConfig() }));
jest.mock('lib/remote-config/values', () => ({
  findAgglayerTokens: () => mockTokens,
  getAgglayerEvmNetworkId: () => 0
}));

function balance(overrides: Partial<TokenBalanceData> = {}, metadata: Partial<TokenBalanceData['metadata']> = {}) {
  const row: TokenBalanceData = {
    tokenId: FAUCET,
    tokenSlug: 'TRNSK',
    metadata: { symbol: 'TRNSK', name: 'Transak Test Token', decimals: 8, ...metadata },
    balance: 500,
    fiatPrice: 0,
    change24h: 0,
    ...overrides
  };
  return row;
}

/** The registry entry of the faucet: bridged from TRNSK on Sepolia, with 18 - 8 = 10 digits of scale. */
function registered(overrides: Partial<BridgeToken> = {}): BridgeToken {
  return { midenFaucetId: `hex:${FAUCET}`, originToken: TRNSK_SEPOLIA, originNetwork: 0, scale: 10, ...overrides };
}

const allowAll = async () => true;

const reasonOf = (resolution: SellTokenResolution) => (resolution.kind === 'blocked' ? resolution.reason : 'ready');

beforeEach(() => {
  mockTokens = [registered()];
  mockPinnedFaucet = undefined;
  mockInitBridgeConfig.mockClear();
});

describe('resolveSellToken', () => {
  it('gives the faucet amount whose exit releases exactly the relay amount', async () => {
    const resolution = await resolveSellToken({ cryptoAmount: '100', balances: [balance()], isAllowed: allowAll });
    expect(resolution).toEqual({
      kind: 'ready',
      token: {
        faucetId: FAUCET,
        symbol: 'TRNSK',
        decimals: 8,
        // 100 at 8 decimals.
        amount: 10_000_000_000n,
        // The same 100 at the 18 decimals of TRNSK on Sepolia: the backend's `tokenAmount`.
        evmAmount: 100n * 10n ** 18n
      }
    });
    expect(mockInitBridgeConfig).toHaveBeenCalled();
  });

  it('keeps a fraction that the faucet can hold', async () => {
    const resolution = await resolveSellToken({ cryptoAmount: '12.5', balances: [balance()], isAllowed: allowAll });
    expect(resolution).toMatchObject({
      kind: 'ready',
      token: { amount: 1_250_000_000n, evmAmount: 125n * 10n ** 17n }
    });
  });

  it('takes only a faucet that has the TRNSK symbol and that the registry accepts', async () => {
    const isAllowed = jest.fn(async (faucetId: string) => faucetId === FAUCET);
    const resolution = await resolveSellToken({
      cryptoAmount: '100',
      balances: [
        balance({ tokenId: 'mtst1eth' }, { symbol: 'ETH' }),
        // A token that only copies the symbol: the registry does not list it.
        balance({ tokenId: OTHER_FAUCET }),
        balance()
      ],
      isAllowed
    });
    expect(resolution).toMatchObject({ kind: 'ready', token: { faucetId: FAUCET } });
    expect(isAllowed).toHaveBeenCalledTimes(2);
    expect(isAllowed).not.toHaveBeenCalledWith('mtst1eth');
  });

  it('uses the pinned faucet id when the wallet has one, whatever its symbol', async () => {
    mockPinnedFaucet = FAUCET;
    const isAllowed = jest.fn(allowAll);
    const resolution = await resolveSellToken({
      cryptoAmount: '100',
      balances: [balance({ tokenId: OTHER_FAUCET }), balance({}, { symbol: 'wTRNSK' })],
      isAllowed
    });
    expect(resolution).toMatchObject({ kind: 'ready', token: { faucetId: FAUCET, symbol: 'wTRNSK' } });
    expect(isAllowed).toHaveBeenCalledTimes(1);
  });

  const blockedCases: ReadonlyArray<[string, () => Promise<SellTokenResolution>]> = [
    ['no-token', () => resolveSellToken({ cryptoAmount: '100', balances: [], isAllowed: allowAll })],
    ['no-token', () => resolveSellToken({ cryptoAmount: '100', balances: [balance()], isAllowed: async () => false })],
    [
      'ambiguous-token',
      () =>
        resolveSellToken({
          cryptoAmount: '100',
          balances: [balance(), balance({ tokenId: OTHER_FAUCET })],
          isAllowed: allowAll
        })
    ],
    [
      'unknown-scale',
      () =>
        resolveSellToken({
          cryptoAmount: '100',
          balances: [balance({}, { scaleIsUnknown: true })],
          isAllowed: allowAll
        })
    ],
    [
      'insufficient-balance',
      () => resolveSellToken({ cryptoAmount: '100', balances: [balance({ balance: 99.99 })], isAllowed: allowAll })
    ],
    // More fraction digits than the 8 decimals of the faucet: the bridge cannot send the exact amount.
    ['amount', () => resolveSellToken({ cryptoAmount: '0.000000001', balances: [balance()], isAllowed: allowAll })],
    ['amount', () => resolveSellToken({ cryptoAmount: '0', balances: [balance()], isAllowed: allowAll })],
    ['amount', () => resolveSellToken({ cryptoAmount: 'ten', balances: [balance()], isAllowed: allowAll })],
    [
      'unavailable',
      () =>
        resolveSellToken({
          cryptoAmount: '100',
          balances: [balance()],
          isAllowed: async () => {
            throw new Error('rpc');
          }
        })
    ]
  ];

  it.each(blockedCases)('blocks the sale with %s', async (reason, resolve) => {
    expect(reasonOf(await resolve())).toBe(reason);
  });

  it('blocks a faucet whose registry scale would release another amount on Ethereum', async () => {
    // 8 decimals and a scale of 9 give 17 decimals: the exit would release a tenth of the relay amount.
    mockTokens = [registered({ scale: 9 })];
    const resolution = await resolveSellToken({ cryptoAmount: '100', balances: [balance()], isAllowed: allowAll });
    expect(reasonOf(resolution)).toBe('amount');
  });

  it('blocks a faucet that the registry maps to another Ethereum token, or does not list', async () => {
    mockTokens = [registered({ originToken: '0x1c7d4b196cb0c7b01d743fbc6116a902379c7238' })];
    expect(reasonOf(await resolveSellToken({ cryptoAmount: '100', balances: [balance()], isAllowed: allowAll }))).toBe(
      'not-registered'
    );

    mockTokens = [registered({ originNetwork: 5 })];
    expect(reasonOf(await resolveSellToken({ cryptoAmount: '100', balances: [balance()], isAllowed: allowAll }))).toBe(
      'not-registered'
    );

    mockTokens = [registered({ midenFaucetId: `hex:${OTHER_FAUCET}` })];
    expect(reasonOf(await resolveSellToken({ cryptoAmount: '100', balances: [balance()], isAllowed: allowAll }))).toBe(
      'not-registered'
    );
  });

  it('blocks the sale while the registry read has not succeeded', async () => {
    mockTokens = null;
    const resolution = await resolveSellToken({ cryptoAmount: '100', balances: [balance()], isAllowed: allowAll });
    expect(resolution).toEqual({ kind: 'blocked', reason: 'unavailable', symbol: 'TRNSK' });
  });
});
