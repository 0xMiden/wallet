/**
 * @jest-environment node
 */
import type { Page } from '@playwright/test';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { formatUnits } from 'viem';
import { sepolia } from 'viem/chains';

import {
  bridgedSendRowOf,
  bridgeOutUsdcx,
  burnSubmitFailure,
  enText,
  expectArcPreselected,
  isArcSnapshotFailure,
  parseBridgeReceiveState,
  readNativeDisplaySymbol,
  reviewQueryParam,
  usdcxChipsProblem,
  usdcxPayoutRowsText,
  waitForReviewSubmitEnabled
} from './bridge';
import {
  ARBITRUM_SEPOLIA_PAYOUT,
  ARC_CHAIN_ID,
  ARC_PAYOUT,
  BASE_SEPOLIA_PAYOUT,
  BURN_UNITS,
  USDCX_DECIMALS
} from './usdcx-constants';
import type { ChromeWalletPageApi } from './wallet-page';

const EN = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../../public/_locales/en/en.json'), 'utf8'));

describe('enText', () => {
  it('returns the English copy verbatim when it has no placeholder', () => {
    expect(enText('usdcxWithdrawalNotice')).toBe(EN.usdcxWithdrawalNotice);
  });

  it('replaces every placeholder it is given', () => {
    expect(enText('guardianHistoryPartial', { count: '3' })).toBe(
      String(EN.guardianHistoryPartial).split('$count$').join('3')
    );
  });

  it('throws on a key the English bundle does not have', () => {
    expect(() => enText('noSuchKeyAnywhere')).toThrow('has no "noSuchKeyAnywhere"');
  });

  it('throws when a placeholder is left unreplaced', () => {
    expect(() => enText('guardianHistoryPartial')).toThrow('still holds $count$');
  });

  it('throws on a value the copy has no placeholder for, so stale copy cannot pass', () => {
    expect(() => enText('usdcxWithdrawalNotice', { symbol: 'USDCX' })).toThrow('has no $symbol$');
  });
});

describe('bridgedSendRowOf', () => {
  const projected = {
    id: '5a249251-3b28-4100-b291-fc5396b61271',
    type: 'bridged-send',
    status: 2,
    stage: 'complete',
    stageTimestamps: { 'creating-proposal': 1791663049003, 'signing-proposal': 1791663049686 },
    displayMessage: 'USDCx burn submitted',
    transactionId: '0xdaca157101a0be401b08c153bcaa530b3644bd6bd68a613d18b203462e1e42b5',
    outputNoteIds: ['0x96711658ddfa001c82aefced0d235827cc727e297eec3fbecd15ca10265f434b'],
    requestBytes: [1, 2],
    feeAmount: '133',
    feeFaucetId: 'mtst1apxtmjhlua0s5vt5sg3ymtnyxclasaf0_qr7qqq9wr6w',
    completedAt: 1791663053,
    resultBytes: 'AAEC',
    submitEvidence: [{ attemptId: '5826a0ee', source: 'pin' }],
    extraInputs: {
      provider: 'usdcx',
      destinationAddress: '0x405b05F75F8D299FCd413a3d77F89EDDCBa78026',
      destinationNetwork: 5042002,
      sourceFaucetId: 'mtst1apxtmjhlua0s5vt5sg3ymtnyxclasaf0_qr7qqq9wr6w',
      claimStatus: 'not-applicable',
      usdcxBurn: {
        noteId: '0x96711658ddfa001c82aefced0d235827cc727e297eec3fbecd15ca10265f434b',
        destinationDomain: 26,
        phase: 'confirmed',
        attemptCount: 0,
        destinationBalanceBefore: { balance: '0', blockNumber: '66531904' },
        destinationBalanceConfirmed: { balance: '9983600', blockNumber: '66531958' }
      }
    }
  };

  it('types a USDCx burn row field by field, including both destination balances', () => {
    expect(bridgedSendRowOf(projected)).toEqual({
      id: '5a249251-3b28-4100-b291-fc5396b61271',
      status: 2,
      stage: 'complete',
      stageTimestamps: { 'creating-proposal': 1791663049003, 'signing-proposal': 1791663049686 },
      displayMessage: 'USDCx burn submitted',
      transactionId: '0xdaca157101a0be401b08c153bcaa530b3644bd6bd68a613d18b203462e1e42b5',
      outputNoteIds: ['0x96711658ddfa001c82aefced0d235827cc727e297eec3fbecd15ca10265f434b'],
      requestBytes: [1, 2],
      feeAmount: '133',
      feeFaucetId: 'mtst1apxtmjhlua0s5vt5sg3ymtnyxclasaf0_qr7qqq9wr6w',
      completedAt: 1791663053,
      resultBytes: 'AAEC',
      submitEvidence: [{ attemptId: '5826a0ee', source: 'pin' }],
      extraInputs: {
        provider: 'usdcx',
        destinationAddress: '0x405b05F75F8D299FCd413a3d77F89EDDCBa78026',
        destinationNetwork: 5042002,
        claimStatus: 'not-applicable',
        usdcxBurn: {
          noteId: '0x96711658ddfa001c82aefced0d235827cc727e297eec3fbecd15ca10265f434b',
          destinationDomain: 26,
          phase: 'confirmed',
          attemptCount: 0,
          destinationBalanceBefore: { balance: '0', blockNumber: '66531904' },
          destinationBalanceConfirmed: { balance: '9983600', blockNumber: '66531958' }
        }
      }
    });
  });

  it('drops a usdcxBurn that lacks its note id, domain or phase rather than half-typing it', () => {
    const row = bridgedSendRowOf({ ...projected, extraInputs: { provider: 'usdcx', usdcxBurn: { noteId: '0x96' } } });
    expect(row.extraInputs?.usdcxBurn).toBeUndefined();
    expect(row.extraInputs?.provider).toBe('usdcx');
  });

  it('reads a row with no status as -1, as the old reader did', () => {
    expect(bridgedSendRowOf({ id: 'r1' }).status).toBe(-1);
    expect(bridgedSendRowOf({ id: 'r1' }).extraInputs).toBeUndefined();
  });
});

describe('parseBridgeReceiveState', () => {
  it('keeps every field the hook returns, typed', () => {
    expect(
      parseBridgeReceiveState({
        found: true,
        phase: 'failed',
        displayMessage: 'Bridged from EVM',
        status: 3,
        amount: '2000000000',
        faucetId: 'mtst1apxtmjhlua0s5vt5sg3ymtnyxclasaf0_qr7qqq9wr6w',
        evmTxHash: '0x370bf19aefa34f6f07d7b731d5b5f323a364c6f4116a22768d4e44a16ffeca4d',
        error: 'Circle attested this deposit to a different Miden account.',
        midenNoteId: '0xbf20',
        sourceChainId: 5042002,
        usdcxRemoteRecipient: '0x000000000000000000000000000000008da911727d5b53916f2c221c00c09100',
        usdcxExecuteTxHash: '0x4247d8f8e4786467aad025ce514b2cdcd72bc7fe3757a8f6aa7273ef48256116',
        readyAt: 1791663100
      })
    ).toEqual({
      found: true,
      phase: 'failed',
      displayMessage: 'Bridged from EVM',
      status: 3,
      amount: '2000000000',
      faucetId: 'mtst1apxtmjhlua0s5vt5sg3ymtnyxclasaf0_qr7qqq9wr6w',
      evmTxHash: '0x370bf19aefa34f6f07d7b731d5b5f323a364c6f4116a22768d4e44a16ffeca4d',
      error: 'Circle attested this deposit to a different Miden account.',
      midenNoteId: '0xbf20',
      sourceChainId: 5042002,
      usdcxRemoteRecipient: '0x000000000000000000000000000000008da911727d5b53916f2c221c00c09100',
      usdcxExecuteTxHash: '0x4247d8f8e4786467aad025ce514b2cdcd72bc7fe3757a8f6aa7273ef48256116',
      readyAt: 1791663100
    });
  });

  it('reads a missing row as not found', () => {
    expect(parseBridgeReceiveState({ found: false })).toEqual({ found: false });
  });

  it('refuses a phase the wallet does not have', () => {
    expect(() => parseBridgeReceiveState({ found: true, phase: 'settled' })).toThrow('unknown phase "settled"');
  });

  it('refuses an answer that is not a state object', () => {
    expect(() => parseBridgeReceiveState(null)).toThrow('not a state object');
  });
});

describe('usdcxChipsProblem', () => {
  const chips = (pressed: string) =>
    [
      'send-network-arc-testnet',
      'send-network-sepolia',
      'send-network-base-sepolia',
      'send-network-arbitrum-sepolia'
    ].map(testId => ({ testId, pressed: testId === pressed ? 'true' : 'false' }));

  it('accepts exactly the four USDCx destinations with only the selected one pressed', () => {
    expect(usdcxChipsProblem(chips('send-network-arc-testnet'), 'send-network-arc-testnet')).toBeUndefined();
  });

  it('names a fifth chip, a missing chip, and a wrongly pressed chip', () => {
    expect(
      usdcxChipsProblem(
        [...chips('send-network-arc-testnet'), { testId: 'send-network-miden', pressed: null }],
        'send-network-arc-testnet'
      )
    ).toContain('send-network-miden');
    expect(usdcxChipsProblem(chips('send-network-arc-testnet').slice(1), 'send-network-arc-testnet')).toContain(
      'expected exactly'
    );
    expect(usdcxChipsProblem(chips('send-network-sepolia'), 'send-network-arc-testnet')).toBe(
      'aria-pressed send-network-arc-testnet=false, send-network-sepolia=true; only send-network-arc-testnet may be pressed'
    );
  });
});

describe('reviewQueryParam', () => {
  it("reads a parameter of the review's hash route", () => {
    const url =
      'chrome-extension://abc/fullpage.html#/send/review?amount=10&to=0x405b&tokenId=mtst1apx_qr7&network=arc-testnet&route=usdcx';
    expect(reviewQueryParam(url, 'network')).toBe('arc-testnet');
    expect(reviewQueryParam(url, 'tokenId')).toBe('mtst1apx_qr7');
    expect(reviewQueryParam('chrome-extension://abc/fullpage.html#/send/review', 'network')).toBeNull();
  });
});

describe('isArcSnapshotFailure', () => {
  it('blames the Arc snapshot only for an RPC-shaped error with no burn row queued', () => {
    expect(isArcSnapshotFailure('HTTP request failed. Status: 429', 0)).toBe(true);
    expect(isArcSnapshotFailure('The request took too long to respond. timed out', 0)).toBe(true);
    expect(isArcSnapshotFailure('HTTP request failed. Status: 429', 1)).toBe(false);
    expect(isArcSnapshotFailure('The amount is below the minimum burn.', 0)).toBe(false);
  });
});

describe('burnSubmitFailure', () => {
  // What viem's error.message, which the review shows, reads on Arbitrum's WalletConnect backend a few blocks behind.
  const WALLET_RPC_ERROR =
    'Missing or invalid parameters.\n\nURL: https://rpc.walletconnect.org/v1?chainId=eip155:421614&projectId=operator-project\n' +
    'Details: unsupported block number 318137572';

  it("keeps Arc's snapshot message as it was", () => {
    expect(burnSubmitFailure(ARC_PAYOUT, 'HTTP request failed. Status: 429', 0)).toBe(
      "Arc RPC unavailable for the wallet's balance snapshot (burn.ts:103), infra: review-error " +
        '"HTTP request failed. Status: 429"'
    );
  });

  it("fails an L2 snapshot refusal as infra naming the wallet RPC's host, never its project id", () => {
    const message = burnSubmitFailure(ARBITRUM_SEPOLIA_PAYOUT, WALLET_RPC_ERROR, 0);
    expect(message).toMatch(
      /^Arbitrum Sepolia RPC rpc\.walletconnect\.org unavailable for the wallet's balance snapshot \(burn\.ts:103\), infra: review-error "/
    );
    expect(message).toContain('projectId=<redacted>');
    expect(message).toContain('unsupported block number 318137572');
    expect(message).not.toContain('operator-project');
  });

  it('calls anything else, or an RPC error once a row was queued, a refusal, still without the project id', () => {
    expect(burnSubmitFailure(BASE_SEPOLIA_PAYOUT, 'The amount is below the minimum burn.', 0)).toBe(
      'the review refused the burn: review-error "The amount is below the minimum burn.", 0 new usdcx rows'
    );
    const queued = burnSubmitFailure(BASE_SEPOLIA_PAYOUT, WALLET_RPC_ERROR, 1);
    expect(queued).toMatch(/^the review refused the burn: review-error "/);
    expect(queued).not.toContain('operator-project');
  });
});

describe('readNativeDisplaySymbol', () => {
  const pageRunningHere = () =>
    ({ evaluate: async <T>(callback: (arg: T) => unknown, arg: T) => callback(arg) }) as unknown as Page;
  const native = 'mtst1apxtmjhlua0s5vt5sg3ymtnyxclasaf0_qr7qqq9wr6w';

  afterEach(() => {
    Reflect.deleteProperty(globalThis, '__TEST_STORE__');
  });

  it("reads the native row's symbol from the current account only", async () => {
    Reflect.set(globalThis, '__TEST_STORE__', {
      getState: () => ({
        currentAccount: { publicKey: 'acct-a' },
        balances: {
          'acct-b': [{ tokenId: native, metadata: { symbol: 'MIDEN' } }],
          'acct-a': [{ tokenId: native, metadata: { symbol: 'USDCX' } }]
        }
      })
    });
    await expect(readNativeDisplaySymbol(pageRunningHere(), native)).resolves.toBe('USDCX');
  });

  it('throws naming the rows it saw when the native row is missing', async () => {
    Reflect.set(globalThis, '__TEST_STORE__', {
      getState: () => ({ currentAccount: { publicKey: 'acct-a' }, balances: { 'acct-a': [{ tokenId: 'other' }] } })
    });
    await expect(readNativeDisplaySymbol(pageRunningHere(), native)).rejects.toThrow('balance rows: other');
  });
});

describe('usdcxPayoutRowsText', () => {
  it("reads both payout rows from the destination's own fee allowance in the wallet", () => {
    // The harness's own burn, whose two rows the small-burn probe read live.
    expect(usdcxPayoutRowsText(ARC_CHAIN_ID, formatUnits(BURN_UNITS, USDCX_DECIMALS))).toEqual({
      fee: 'Up to 0.1 USDC',
      net: 'At least 0.9 USDC'
    });
    expect(usdcxPayoutRowsText(sepolia.id, '10')).toEqual({ fee: 'Up to 1.5 USDC', net: 'At least 8.5 USDC' });
  });

  it('refuses an amount the allowance takes whole, naming both, and takes the least amount above it', () => {
    expect(() => usdcxPayoutRowsText(ARC_CHAIN_ID, '0.1')).toThrow(
      '0.1 USDCx does not exceed the 0.1 USDC payout fee allowance on Arc Testnet'
    );
    expect(usdcxPayoutRowsText(ARC_CHAIN_ID, '0.100001').net).toBe('At least 0.000001 USDC');
  });

  // A pin, green before and after: the payout rows carry no chain, so the L2 burns show Arc's text.
  it("quotes the same rows on Base Sepolia and Arbitrum Sepolia, whose allowance is Arc's", () => {
    for (const chain of [BASE_SEPOLIA_PAYOUT, ARBITRUM_SEPOLIA_PAYOUT]) {
      expect(usdcxPayoutRowsText(chain.chainId, '1')).toEqual({ fee: 'Up to 0.1 USDC', net: 'At least 0.9 USDC' });
    }
  });
});

describe('bridgeOutUsdcx', () => {
  it('refuses an amount the Arc fee allowance takes whole before it touches the page', async () => {
    const touched: string[] = [];
    const page = new Proxy(
      {},
      {
        get: (_target, property) => {
          touched.push(String(property));
          return () => Promise.reject(new Error('the page was driven'));
        }
      }
    );
    const wallet = { page, extensionId: 'abc' } as unknown as ChromeWalletPageApi;
    await expect(
      bridgeOutUsdcx(wallet, {
        destAddress: '0x405b05F75F8D299FCd413a3d77F89EDDCBa78026',
        amount: '0.1',
        nativeTokenId: 'mtst1apxtmjhlua0s5vt5sg3ymtnyxclasaf0_qr7qqq9wr6w',
        nativeSymbol: 'USDCX',
        screenshotDir: path.join(os.tmpdir(), 'bridge-out-usdcx-refused')
      })
    ).rejects.toThrow('0.1 USDCx does not exceed the 0.1 USDC payout fee allowance on Arc Testnet');
    expect(touched).toEqual([]);
  });

  it("refuses an amount the destination's allowance takes whole, naming that destination, before it touches the page", async () => {
    const touched: string[] = [];
    const page = new Proxy(
      {},
      {
        get: (_target, property) => {
          touched.push(String(property));
          return () => Promise.reject(new Error('the page was driven'));
        }
      }
    );
    const wallet = { page, extensionId: 'abc' } as unknown as ChromeWalletPageApi;
    await expect(
      bridgeOutUsdcx(wallet, {
        destAddress: '0x405b05F75F8D299FCd413a3d77F89EDDCBa78026',
        amount: '0.1',
        nativeTokenId: 'mtst1apxtmjhlua0s5vt5sg3ymtnyxclasaf0_qr7qqq9wr6w',
        nativeSymbol: 'USDCX',
        screenshotDir: path.join(os.tmpdir(), 'bridge-out-usdcx-refused-l2'),
        payoutChain: BASE_SEPOLIA_PAYOUT
      })
    ).rejects.toThrow('0.1 USDCx does not exceed the 0.1 USDC payout fee allowance on Base Sepolia');
    expect(touched).toEqual([]);
  });
});

describe('expectArcPreselected', () => {
  const pageWithChips = (pressed: string) =>
    ({
      locator: () => ({
        evaluateAll: async () =>
          [
            'send-network-arc-testnet',
            'send-network-sepolia',
            'send-network-base-sepolia',
            'send-network-arbitrum-sepolia'
          ].map(testId => ({ testId, pressed: testId === pressed ? 'true' : 'false' }))
      })
    }) as unknown as Page;

  it('resolves once Arc Testnet alone is pressed among the four chips', async () => {
    await expect(expectArcPreselected(pageWithChips('send-network-arc-testnet'), 1_000)).resolves.toBeUndefined();
  });

  it('says it checks the chip set and the default, not USDCx mode', async () => {
    await expect(expectArcPreselected(pageWithChips('send-network-sepolia'), 300)).rejects.toThrow(
      'checks the chip set and its default'
    );
  });
});

describe('waitForReviewSubmitEnabled', () => {
  const reviewPage = (submitEnabled: () => boolean, reviewError: string | null) =>
    ({
      getByTestId: (testId: string) =>
        testId === 'send-review-submit'
          ? { isEnabled: async () => submitEnabled() }
          : { isVisible: async () => reviewError !== null, textContent: async () => reviewError }
    }) as unknown as Page;

  it('waits while the submit is disabled and no refusal shows, then resolves once it enables', async () => {
    let reads = 0;
    const page = reviewPage(() => ++reads >= 3, null);
    await expect(waitForReviewSubmitEnabled(page, 10_000)).resolves.toBeUndefined();
    expect(reads).toBe(3);
  });

  it('throws the review-error text at once instead of waiting out its timeout', async () => {
    const refusal = enText('usdcxSendMoreThanPayoutFee', { amount: '0.1', network: 'Arc Testnet' });
    const page = reviewPage(() => false, refusal);
    await expect(waitForReviewSubmitEnabled(page, 60_000)).rejects.toThrow(
      `the review refused the burn before submit: review-error "${refusal}"`
    );
  });
});
