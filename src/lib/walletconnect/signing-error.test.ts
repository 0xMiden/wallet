import i18next from 'i18next';

import { NativeSessionChainNotApprovedError } from './native';
import { nativeSigningErrorId, nativeSigningErrorMessage } from './signing-error';

jest.mock('./native', () => {
  class NativeSessionChainNotApprovedError extends Error {
    constructor(
      readonly chainId: number,
      readonly networkName: string
    ) {
      super(`not approved: ${networkName}`);
    }
  }
  return { NativeSessionChainNotApprovedError };
});

// An instance without resources returns the key for every lookup.
const i18n = i18next.createInstance();
const t = i18n.t;

beforeAll(async () => {
  await i18n.init({ lng: 'en', resources: {} });
});

// The message MetaMask returns when its Smart Transactions relay answers with an HTTP 500.
const RELAY_FAILURE = 'Fetch error:{"status":500,"error":"Internal Server Error","statusCode":500}';

describe('signing-error', () => {
  it('maps a Smart Transactions relay failure to its own id and message', () => {
    const err = new Error(RELAY_FAILURE);
    expect(nativeSigningErrorId(err)).toBe('evmWalletSmartTransactionsFailed');
    expect(nativeSigningErrorMessage(err, t)).toBe('evmWalletSmartTransactionsFailed');
  });

  it('finds the relay failure down the cause chain and in a plain rejection object', () => {
    const wrapped = new Error('Transaction failed', { cause: new Error(RELAY_FAILURE) });
    expect(nativeSigningErrorId(wrapped)).toBe('evmWalletSmartTransactionsFailed');
    expect(nativeSigningErrorId({ message: '{"status":503,"error":"x","statusCode":503}' })).toBe(
      'evmWalletSmartTransactionsFailed'
    );
  });

  it('does not match an RPC 500 of a read that the wallet makes', () => {
    const err = new Error('HTTP request failed.\n\nStatus: 500\nURL: https://rpc.example\nDetails: {"statusCode":500}');
    expect(nativeSigningErrorId(err)).toBeUndefined();
    expect(nativeSigningErrorMessage(err, t)).toBe(err.message);
  });

  it('keeps the chain-not-approved message first', () => {
    const err = new NativeSessionChainNotApprovedError(11155111, 'Sepolia');
    expect(nativeSigningErrorId(err)).toBe('evmChainNotApproved');
    expect(nativeSigningErrorMessage(err, t)).toBe('evmChainNotApproved');
  });
});
