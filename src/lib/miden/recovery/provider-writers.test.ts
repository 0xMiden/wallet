import type { EIP1193Provider } from 'viem';

import { OneClickDepositBroadcastError, submitEvmOneClickDeposit } from 'lib/one-click/evm';
import {
  claimOneClickEvmDepositAttempt,
  persistOneClickTrackingRow,
  recordOneClickOriginTransactionHash
} from 'lib/one-click/tracking';
import type { OneClickTrackingInput } from 'lib/one-click/tracking';

import type { IEarnWithdrawPreparedExecution, IOneClickTrackingData } from '../db/types';
import * as Repo from '../repo';
import { getStorageHealth } from '../storage-health';
import { installProviderReceiptBackend } from './receipt-backend';
import { fromSerializable } from './serialization';
import { earnReceiptRow, oneClickReceiptRow } from './testing/provider-receipts';
import { validateRecoveryReceipt } from './transaction-record';
import { prepareEarnWithdrawExecution, updateBridgedReceivePhase } from '../transaction/complete';

jest.mock('lib/one-click/client', () => ({
  ...jest.requireActual('lib/one-click/client'),
  assertOneClickQuoteBinding: jest.fn()
}));
jest.mock('lib/one-click/evm-balance', () => ({ assertOneClickEvmDepositFunded: jest.fn() }));
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
function input(): OneClickTrackingInput {
  const row = oneClickReceiptRow();
  const old: IOneClickTrackingData = row.extraInputs.oneClick;
  const deadline = '2099-01-01T00:00:00Z';
  const originAsset = { ...old.originAsset, contractAddress: '0x1111111111111111111111111111111111111111', chainId: 1 };
  const request = { ...old.request, deadline, originAsset };
  const quote = {
    ...old.quote,
    quoteRequest: { ...old.quote.quoteRequest, deadline },
    quote: { ...old.quote.quote, deadline }
  };
  return { ...old, originAsset, request, quote, config: { ...old.config, evmAssets: [originAsset] } };
}
const hash = `0x${'a'.repeat(64)}`;
function funding(rowId: string, args: OneClickTrackingInput) {
  const sent = deferred();
  let sends = 0;
  const wallet: EIP1193Provider = {
    request: jest.fn().mockImplementation(async ({ method }: { method: string }) => {
      if (method === 'eth_chainId') return '0x1';
      if (method === 'eth_accounts') return [args.request.refundTo];
      if (method === 'eth_sendTransaction') {
        sends++;
        sent.release();
        return hash;
      }
      throw new Error(`Unexpected wallet request ${method}`);
    }),
    on: jest.fn(),
    removeListener: jest.fn()
  };
  const result = submitEvmOneClickDeposit({
    provider: wallet,
    account: args.request.refundTo,
    request: args.request,
    quote: args.quote,
    config: args.config,
    onAttempting: () => claimOneClickEvmDepositAttempt(rowId),
    onSubmitted: value => recordOneClickOriginTransactionHash(rowId, value)
  });
  return { result, sent, sends: () => sends };
}

beforeEach(async () => {
  await Repo.db.open();
  installProviderReceiptBackend(async () => {});
});
afterEach(() => {
  for (const release of releases.splice(0)) release();
  installProviderReceiptBackend(undefined);
});

it('Task4C2 OneClick creation waits for independent receipt acknowledgement before returning its id', async () => {
  const entered = deferred();
  const ack = deferred();
  installProviderReceiptBackend(async () => {
    entered.release();
    await ack.promise;
  });
  let settled = false;
  const result = persistOneClickTrackingRow(input()).then(id => {
    settled = true;
    return id;
  });
  await Promise.race([entered.promise, result]);
  expect(settled).toBe(false);
  ack.release();
  const id = await result;
  expect((await Repo.transactions.get(id))?.extraInputs.oneClick.depositMemo).toBe('receipt-memo');
});

it('Task4C2 OneClick funding waits for retained attempted evidence before sending', async () => {
  const args = input();
  const id = await persistOneClickTrackingRow(args);
  const entered = deferred();
  const ack = deferred();
  installProviderReceiptBackend(async value => {
    if (validateRecoveryReceipt(fromSerializable(value)).extraInputs?.oneClick?.evmSubmission === 'attempted') {
      entered.release();
      await ack.promise;
    }
  });
  const operation = funding(id, args);
  const outcome = operation.result.catch((error: unknown) => error);
  await Promise.race([entered.promise, operation.sent.promise, outcome]);
  expect(operation.sends()).toBe(0);
  ack.release();
  await expect(outcome).resolves.toBe(hash);
  expect(operation.sends()).toBe(1);
});

it('Task4C2 OneClick refused attempted retention prevents funding and keeps the claim sticky', async () => {
  const args = input();
  const id = await persistOneClickTrackingRow(args);
  installProviderReceiptBackend(async () => {
    throw new Error('receipt refused');
  });
  const operation = funding(id, args);
  await expect(operation.result).rejects.toThrow('receipt refused');
  expect(operation.sends()).toBe(0);
  expect((await Repo.transactions.get(id))?.extraInputs.oneClick.evmSubmission).toBe('attempted');
  await expect(claimOneClickEvmDepositAttempt(id)).rejects.toThrow();
});

it('Task4C2 OneClick postbroadcast retention refusal preserves one send and its known hash', async () => {
  const args = input();
  const id = await persistOneClickTrackingRow(args);
  installProviderReceiptBackend(async value => {
    if (validateRecoveryReceipt(fromSerializable(value)).extraInputs?.oneClick?.evmSubmission === 'known')
      throw new Error('receipt refused');
  });
  const operation = funding(id, args);
  const result = await operation.result.catch((error: unknown) => error);
  expect(result).toBeInstanceOf(OneClickDepositBroadcastError);
  expect(operation.sends()).toBe(1);
  expect((await Repo.transactions.get(id))?.extraInputs.oneClick.originTransactionHash).toBe(hash);
});

async function preparingEarn() {
  const row = earnReceiptRow();
  const execution: IEarnWithdrawPreparedExecution = row.extraInputs.preparedExecution;
  row.extraInputs.phase = 'redeeming';
  row.extraInputs.submissionState = 'preparing';
  delete row.extraInputs.preparedExecution;
  delete row.extraInputs.withdrawIntentNonce;
  await Repo.transactions.put(row);
  return { row, execution, expected: { owner: row.extraInputs.evmOwner, attemptId: 'attempt-1', nonce: '22' } };
}

it('Task4C2 Earn preparation waits for independent acknowledgement before permitting execution', async () => {
  const { row, execution, expected } = await preparingEarn();
  const entered = deferred();
  const ack = deferred();
  installProviderReceiptBackend(async () => {
    entered.release();
    await ack.promise;
  });
  let settled = false;
  const result = prepareEarnWithdrawExecution(row.id, execution, expected, () => true).then(value => {
    settled = true;
    return value;
  });
  await Promise.race([entered.promise, result]);
  expect(settled).toBe(false);
  ack.release();
  await expect(result).resolves.toBe(true);
});

it('Task4C2 Earn preparation refuses an attempt replaced while its receipt acknowledgement waited', async () => {
  const { row, execution, expected } = await preparingEarn();
  const entered = deferred();
  const ack = deferred();
  let reached = false;
  installProviderReceiptBackend(async () => {
    reached = true;
    entered.release();
    await ack.promise;
  });
  const result = prepareEarnWithdrawExecution(row.id, execution, expected, () => true);
  await Promise.race([entered.promise, result]);
  expect(reached).toBe(true);
  await Repo.transactions.where({ id: row.id }).modify(tx => {
    tx.extraInputs.submissionAttemptId = 'attempt-2';
  });
  ack.release();
  await expect(result).resolves.toBe(false);
  expect((await Repo.transactions.get(row.id))?.extraInputs.submissionAttemptId).toBe('attempt-2');
  expect(getStorageHealth().status).toBe('healthy');
});

it('Task4C2 CCTP enrichment retains the merged latest receipt before reporting progress', async () => {
  const row = oneClickReceiptRow();
  delete row.extraInputs.oneClick;
  row.extraInputs.provider = 'usdcx';
  row.extraInputs.cctp = { sourceDomain: 0, executeTxHash: hash };
  await Repo.transactions.put(row);
  const entered = deferred();
  const ack = deferred();
  let saved: unknown;
  installProviderReceiptBackend(async value => {
    saved = fromSerializable(value);
    entered.release();
    await ack.promise;
  });
  let settled = false;
  const result = updateBridgedReceivePhase(row.id, 'delivering', {
    cctp: { sourceDomain: 0, message: '0x01', attestation: '0x02' }
  }).then(() => {
    settled = true;
  });
  await Promise.race([entered.promise, result]);
  expect(settled).toBe(false);
  expect(saved).toMatchObject({
    extraInputs: { cctp: { sourceDomain: 0, executeTxHash: hash, message: '0x01', attestation: '0x02' } }
  });
  ack.release();
  await result;
});

it('Task4C2 stale CCTP reopen keeps the newer hash without poisoning healthy storage', async () => {
  const row = oneClickReceiptRow();
  delete row.extraInputs.oneClick;
  row.extraInputs.provider = 'usdcx';
  row.extraInputs.cctp = { sourceDomain: 0, executeTxHash: hash };
  await Repo.transactions.put(row);
  let retained = 0;
  installProviderReceiptBackend(async () => {
    retained++;
  });
  await updateBridgedReceivePhase(row.id, 'delivering', {
    cctp: { sourceDomain: 0, revertedExecuteTxHash: `0x${'b'.repeat(64)}`, executeTxHash: undefined }
  });
  expect((await Repo.transactions.get(row.id))?.extraInputs.cctp.executeTxHash).toBe(hash);
  expect(retained).toBe(0);
  expect(getStorageHealth().status).toBe('healthy');
});
