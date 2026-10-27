import type { Hash } from 'viem';

import { updateOneClickTrackingPhase } from 'lib/one-click/tracking';
import { getUsdcxExecutorSource, getUsdcxXReserveSource } from 'lib/usdcx/constant';
import { runUsdcxDeposit } from 'lib/usdcx/deposit';
import { runUsdcxExecutorDeposit } from 'lib/usdcx/executor';

import * as Repo from '../repo';
import { markStorageUnavailable } from '../storage-health';
import { installProviderReceiptBackend } from './receipt-backend';
import { markEarnWithdrawAccepted, updateEarnWithdrawPhase, updateBridgedReceivePhase } from '../transaction/complete';
import { initiateBridgedReceiveTransaction, initiateEarnWithdrawTransaction } from '../transaction/initiate';
import { earnReceiptRow, oneClickReceiptRow } from './testing/provider-receipts';

jest.mock('lib/remote-config/runtime', () => ({
  getBridgeConfigSnapshot: () =>
    jest
      .requireActual<typeof import('lib/remote-config/testing/fixture')>('lib/remote-config/testing/fixture')
      .testBridgeSnapshot()
}));
jest.mock('@miden-sdk/miden-sdk', () => ({
  ...jest.requireActual('@miden-sdk/miden-sdk'),
  AccountId: { fromHex: (value: string) => ({ toString: () => value }) }
}));
const releases: Array<() => void> = [];
function deferred() {
  let release = () => {};
  const promise = new Promise<void>(resolve => {
    release = resolve;
  });
  releases.push(release);
  return { promise, release };
}
function pauseRetention() {
  const entered = deferred();
  const ack = deferred();
  installProviderReceiptBackend(async () => {
    entered.release();
    await ack.promise;
  });
  return { entered, ack };
}
const hash: Hash = `0x${'a'.repeat(64)}`;
const recipient = '0x00000000000000000000000000000000b64e1827414584510723cad8e145a400';
const depositor: `0x${string}` = '0x1111111111111111111111111111111111111111';
const agglayerRoute = {
  chainId: 1,
  contractAddress: depositor,
  midenBridgeId: 'bridge',
  indexerUrl: 'https://indexer.example',
  rollupId: 1,
  evmNetworkId: 0
};

beforeEach(async () => {
  await Repo.db.open();
  installProviderReceiptBackend(async () => {});
});
afterEach(() => {
  for (const release of releases.splice(0)) release();
  installProviderReceiptBackend(undefined);
});

it.each<'epoch' | 'agglayer' | 'usdcx'>(['epoch', 'agglayer', 'usdcx'])(
  'Task4C2 boundaries retain the initial %s receipt before returning its tracking id',
  async provider => {
    const { entered, ack } = pauseRetention();
    let settled = false;
    const result = initiateBridgedReceiveTransaction({
      accountId: 'account-a',
      amount: 1n,
      faucetId: 'faucet',
      provider,
      sourceAddress: depositor,
      sourceAmount: '1',
      sourceSymbol: 'USDC',
      sourceChainId: 5042002,
      agglayerRoute,
      usdcxSource: getUsdcxXReserveSource(5042002),
      epochAllocatorUrl: 'https://allocator.example'
    }).then(id => {
      settled = true;
      return id;
    });
    await Promise.race([entered.promise, result]);
    expect(settled).toBe(false);
    ack.release();
    const id = await result;
    expect((await Repo.transactions.get(id))?.extraInputs.provider).toBe(provider);
  }
);

it('Task4C2 boundaries retain the initial Earn withdrawal before returning its tracking id', async () => {
  const fixture = earnReceiptRow();
  const { entered, ack } = pauseRetention();
  let settled = false;
  const result = initiateEarnWithdrawTransaction(
    fixture.accountId,
    10n,
    fixture.extraInputs.evmOwner,
    fixture.extraInputs.marketUid,
    fixture.extraInputs.destinationFaucetId,
    '10',
    'USDC',
    'attempt-1',
    1,
    6
  ).then(id => {
    settled = true;
    return id;
  });
  await Promise.race([entered.promise, result]);
  expect(settled).toBe(false);
  ack.release();
  await result;
});

it.each(['accepted', 'phase'])(
  'Task4C2 boundaries retain merged Earn %s enrichment before acknowledging progress',
  async writer => {
    const row = earnReceiptRow();
    await Repo.transactions.put(row);
    const { entered, ack } = pauseRetention();
    let settled = false;
    const expected = { owner: row.extraInputs.evmOwner, attemptId: 'attempt-1', nonce: '22' };
    const operation =
      writer === 'accepted'
        ? markEarnWithdrawAccepted(row.id, expected, () => true)
        : updateEarnWithdrawPhase(row.id, 'received', { midenNoteId: 'delivered-note' }, undefined, expected);
    const result = operation.then(() => {
      settled = true;
    });
    await Promise.race([entered.promise, result]);
    expect(settled).toBe(false);
    ack.release();
    await result;
  }
);

it('Task4C2 boundaries retain OneClick phase enrichment before acknowledging progress', async () => {
  const row = oneClickReceiptRow();
  await Repo.transactions.put(row);
  const { entered, ack } = pauseRetention();
  let settled = false;
  const result = updateOneClickTrackingPhase(row.id, 'delivered').then(() => {
    settled = true;
  });
  await Promise.race([entered.promise, result]);
  expect(settled).toBe(false);
  ack.release();
  await result;
});

it.each(['xreserve', 'executor'])(
  'Task4C2 boundaries retain a conservative %s attempt before any source wallet mutation',
  async route => {
    const source = route === 'xreserve' ? getUsdcxXReserveSource(5042002) : getUsdcxExecutorSource(84532);
    const id = await initiateBridgedReceiveTransaction({
      accountId: 'account-a',
      amount: 1_000_000n,
      faucetId: 'faucet',
      provider: 'usdcx',
      sourceAddress: depositor,
      sourceAmount: '1',
      sourceSymbol: 'USDC',
      sourceChainId: source.chain.id,
      usdcxSource: source
    });
    const { entered, ack } = pauseRetention();
    const sent = deferred();
    let calls = 0;
    const send = async () => {
      calls++;
      sent.release();
      return hash;
    };
    const shared = {
      isRemoteDomainRegistered: async () => true,
      readAllowance: async () => 0n,
      waitForReceipt: async () => {},
      updatePhase: updateBridgedReceivePhase
    };
    const operation =
      source.route === 'xreserve'
        ? runUsdcxDeposit(id, '1', recipient, {
            ...shared,
            source,
            sourceChainId: source.chain.id,
            signer: { approve: send, depositToRemote: send }
          })
        : runUsdcxExecutorDeposit(id, '1', recipient, {
            ...shared,
            source,
            depositor,
            readBalance: async () => 2_000_000n,
            signer: { approve: send, depositForBurnWithHookAndFees: send },
            fetchQuote: async () => ({
              signedQuote: '0x0102',
              feeTotalAmount: 100n,
              expiresAt: Math.floor(Date.now() / 1000) + 120
            })
          });
    const result = operation.catch((error: unknown) => error);
    await Promise.race([entered.promise, sent.promise, result]);
    expect(calls).toBe(0);
    expect((await Repo.transactions.get(id))?.extraInputs.sourceSubmission).toBe('attempted');
    ack.release();
    await result;
    expect(calls).toBe(2);
  }
);

it.each(['xreserve', 'executor'])(
  'Task4C2 finalseams refuses %s source funding after storage health changes during approval',
  async route => {
    const source = route === 'xreserve' ? getUsdcxXReserveSource(5042002) : getUsdcxExecutorSource(84532);
    const id = await initiateBridgedReceiveTransaction({
      accountId: 'account-a',
      amount: 1_000_000n,
      faucetId: 'faucet',
      provider: 'usdcx',
      sourceAddress: depositor,
      sourceAmount: '1',
      sourceSymbol: 'USDC',
      sourceChainId: source.chain.id,
      usdcxSource: source
    });
    let funded = 0;
    const send = async () => {
      funded++;
      return hash;
    };
    const shared = {
      isRemoteDomainRegistered: async () => true,
      readAllowance: async () => 0n,
      waitForReceipt: async () => {
        markStorageUnavailable('journal', { backend: 'independent', operation: 'mutate' });
      },
      updatePhase: updateBridgedReceivePhase
    };
    const operation =
      source.route === 'xreserve'
        ? runUsdcxDeposit(id, '1', recipient, {
            ...shared,
            source,
            sourceChainId: source.chain.id,
            signer: { approve: async () => hash, depositToRemote: send }
          })
        : runUsdcxExecutorDeposit(id, '1', recipient, {
            ...shared,
            source,
            depositor,
            readBalance: async () => 2_000_000n,
            signer: { approve: async () => hash, depositForBurnWithHookAndFees: send },
            fetchQuote: async () => ({
              signedQuote: '0x0102',
              feeTotalAmount: 100n,
              expiresAt: Math.floor(Date.now() / 1000) + 120
            })
          });
    await operation.catch(() => {});
    expect(funded).toBe(0);
    expect((await Repo.transactions.get(id))?.extraInputs.sourceSubmission).toBe('attempted');
  }
);
