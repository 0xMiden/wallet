import { reconcileOneClickSwaps, retireOneClickEvmPreflightFailure } from 'lib/one-click/tracking';
import { pollUsdcxBurn } from 'lib/usdcx/burn-status';
import { pollUsdcxDestination } from 'lib/usdcx/destination-status';
import type { ITransaction } from '../db/types';
import * as Repo from '../repo';
import {
  updateEarnDepositStatus,
  updateBridgeClaimStatus,
  pinAgglayerDeposit,
  recordAgglayerExitTxHash
} from '../transaction/complete';
import { installProviderReceiptBackend } from './receipt-backend';
import { oneClickReceiptRow } from './testing/provider-receipts';

const mockStatus = jest.fn();
jest.mock('lib/one-click/client', () => ({
  ...jest.requireActual<typeof import('lib/one-click/client')>('lib/one-click/client'),
  fetchOneClickStatus: (...args: unknown[]) => mockStatus(...args)
}));
jest.mock('lib/remote-config/runtime', () => ({
  getBridgeConfigSnapshot: () =>
    jest
      .requireActual<typeof import('lib/remote-config/testing/fixture')>('lib/remote-config/testing/fixture')
      .testBridgeSnapshot()
}));
const hash = '0x1111111111111111111111111111111111111111111111111111111111111111';
const address = '0x1111111111111111111111111111111111111111';
function deferred() {
  let release = () => {};
  const promise = new Promise<void>(resolve => {
    release = resolve;
  });
  return { promise, release };
}
function outgoing(provider: 'epoch' | 'agglayer' | 'usdcx' = 'agglayer'): ITransaction {
  const row = oneClickReceiptRow();
  return {
    ...row,
    type: 'bridged-send',
    extraInputs: {
      provider,
      destinationAddress: address,
      destinationNetwork: 11155111,
      sourceFaucetId: row.faucetId,
      claimStatus: 'pending',
      agglayerExitTxHash: hash,
      usdcxBurn:
        provider === 'usdcx'
          ? {
              noteId: 'burn-note',
              destinationDomain: 0,
              destinationUsdc: address,
              phase: 'pending',
              destinationBalanceBefore: { balance: '0', blockNumber: '1' }
            }
          : undefined
    }
  };
}
beforeEach(async () => {
  await Repo.db.open();
  installProviderReceiptBackend(async () => {});
});
afterEach(() => installProviderReceiptBackend(undefined));
it.each(['earn', 'claim', 'pin', 'exit', 'burn', 'payout', 'oneclick', 'preflight'])(
  'Task4C2 enrichment retains accepted %s evidence before its writer resolves',
  async writer => {
    const row =
      writer === 'oneclick' || writer === 'preflight'
        ? oneClickReceiptRow()
        : outgoing(writer === 'burn' || writer === 'payout' ? 'usdcx' : 'agglayer');
    if (writer === 'earn') {
      row.type = 'earn-deposit';
      row.extraInputs = { evmRecipient: address, marketUid: 'market', epochStatus: 'pending' };
    }
    if (writer === 'exit') row.extraInputs.agglayerExitTxHash = undefined;
    if (writer === 'payout') row.extraInputs.usdcxBurn.phase = 'confirmed';
    if (writer === 'oneclick') {
      row.extraInputs.oneClick.providerSubmitted = true;
      mockStatus.mockResolvedValue({
        ...row.extraInputs.oneClick.statusResponse,
        status: 'FAILED',
        updatedAt: '2020-01-01T00:02:00Z'
      });
    }
    if (writer === 'preflight') {
      row.extraInputs.oneClick.originTransactionHash = undefined;
      row.extraInputs.oneClick.evmSubmission = 'attempted';
    }
    await Repo.transactions.put(row);
    const entered = deferred();
    const ack = deferred();
    let retained: unknown;
    installProviderReceiptBackend(async value => {
      retained = value;
      entered.release();
      await ack.promise;
    });
    const operation =
      writer === 'earn'
        ? updateEarnDepositStatus(row.id, 'pending', { intentNonce: '22' })
        : writer === 'claim'
          ? updateBridgeClaimStatus(row.id, 'claiming', { agglayerDepositCnt: 7 }, hash)
          : writer === 'pin'
            ? pinAgglayerDeposit(row.id, 7)
            : writer === 'exit'
              ? recordAgglayerExitTxHash(row.id, hash)
              : writer === 'burn'
                ? pollUsdcxBurn(row, async () => ({ status: 'NullifierCommitted', attemptCount: 2 }))
                : writer === 'payout'
                  ? pollUsdcxDestination(row, {
                      readSource: async () => ({ gatewayMinter: address, depositor: hash, sourceDomain: 1 }),
                      scan: async () => ({
                        payout: { transactionHash: hash, blockNumber: '300', value: '900000' },
                        scannedTo: 300n,
                        head: 300n
                      })
                    })
                  : writer === 'oneclick'
                    ? reconcileOneClickSwaps()
                    : retireOneClickEvmPreflightFailure(row.id, true);
    let settled = false;
    const result = operation.then(() => {
      settled = true;
    });
    try {
      await Promise.race([entered.promise, result]);
      expect(settled).toBe(false);
      expect(retained).toMatchObject({ id: row.id, type: row.type });
      const expected =
        writer === 'earn'
          ? { intentNonce: '22' }
          : writer === 'claim'
            ? { claimStatus: 'claiming', agglayerDepositCnt: 7 }
            : writer === 'pin'
              ? { agglayerDepositCnt: 7 }
              : writer === 'exit'
                ? { agglayerExitTxHash: hash }
                : writer === 'burn'
                  ? { usdcxBurn: { noteId: 'burn-note', phase: 'confirmed', attemptCount: 2 } }
                  : writer === 'payout'
                    ? { usdcxBurn: { payout: { transactionHash: hash, blockNumber: '300', value: '900000' } } }
                    : writer === 'oneclick'
                      ? { oneClick: { providerStatus: 'FAILED', statusResponse: { status: 'FAILED' } } }
                      : { oneClick: { evmSubmission: 'not-started', phase: 'failed' } };
      expect(retained).toMatchObject({ extraInputs: expected });
      ack.release();
      await result;
      const current = await Repo.transactions.get(row.id);
      expect(current?.status).toBe(row.status);
    } finally {
      ack.release();
      await result;
    }
  }
);
