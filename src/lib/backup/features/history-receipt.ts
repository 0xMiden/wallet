import type { ITransactionType } from 'lib/miden/db/types';
import { isRecord } from 'lib/update/guards';

type ReceiptInput = string | number | boolean | bigint | object;
type ReceiptValue = string | number | boolean | ReceiptFields | ReceiptValue[];
export interface ReceiptFields {
  [key: string]: ReceiptValue;
}

type Field =
  | 'string'
  | 'number'
  | 'boolean'
  | 'decimal'
  | 'identifier'
  | { fields: Shape; required?: readonly string[] }
  | { list: Field }
  | { byNoteId: Field };
type Shape = Record<string, Field>;

const fields = (shape: Shape, required?: readonly string[]): Field => ({ fields: shape, required });
const list = (field: Field): Field => ({ list: field });
/** A record whose keys are note ids. A key of another shape is dropped. */
const byNoteId = (field: Field): Field => ({ byNoteId: field });
const NOTE_ID_KEY = /^(0x)?[0-9a-fA-F]{1,128}$/;

const asset = fields({ blockchain: 'string', symbol: 'string', decimals: 'number', chainId: 'number' }, [
  'blockchain',
  'symbol',
  'decimals'
]);
const chainTransaction = fields({ hash: 'string', explorerUrl: 'string' }, ['hash', 'explorerUrl']);
const oneClick = fields(
  {
    direction: 'string',
    network: 'string',
    amount: 'decimal',
    phase: 'string',
    providerStatus: 'string',
    depositAddress: 'string',
    depositMemo: 'string',
    fundingDeadline: 'string',
    updatedAt: 'number',
    error: 'string',
    originAsset: asset,
    destinationAsset: asset,
    request: fields({ refundTo: 'string', deadline: 'string' }, ['refundTo']),
    quote: fields(
      {
        quote: fields(
          {
            amountIn: 'decimal',
            amountOut: 'decimal',
            minAmountOut: 'decimal',
            deadline: 'string',
            timeWhenInactive: 'string'
          },
          ['amountIn', 'amountOut', 'minAmountOut']
        )
      },
      ['quote']
    ),
    config: fields({ chains: list(fields({ id: 'string', name: 'string' }, ['id', 'name'])) }),
    statusResponse: fields(
      {
        swapDetails: fields({
          depositedAmount: 'decimal',
          amountOut: 'decimal',
          refundedAmount: 'decimal',
          refundReason: 'string',
          originChainTxHashes: list(chainTransaction),
          destinationChainTxHashes: list(chainTransaction)
        })
      },
      ['swapDetails']
    )
  },
  ['direction', 'network', 'amount', 'phase', 'originAsset', 'destinationAsset', 'request', 'quote', 'config']
);

const agglayerRoute = fields({
  chainId: 'number',
  contractAddress: 'string',
  midenBridgeId: 'string',
  rollupId: 'number',
  evmNetworkId: 'number'
});

const receiptFields: Record<ITransactionType, Shape> = {
  send: { recallBlocks: 'number', calendarRecallTarget: 'string', oneClick },
  execute: {},
  consume: {
    swapOrderTxId: 'string',
    swapSettleKind: 'string',
    // What each payback of the claim paid. A device that did not place the order has no lineage, so these amounts
    // are its only exact record of the fill (multi-device).
    swapPaybackAmounts: byNoteId('decimal'),
    midenNameClaim: fields({ label: 'string', registerTxId: 'string' }, ['label', 'registerTxId']),
    bridgeIn: fields(
      {
        provider: 'string',
        sourceAmount: 'string',
        sourceSymbol: 'string',
        sourceToken: 'string',
        intentOwner: 'string',
        intentNonce: 'string',
        evmTxHash: 'string',
        midenNoteId: 'string',
        bridgeReceiveTxId: 'string',
        earnWithdrawTxId: 'string',
        earnWithdrawAttemptId: 'string'
      },
      ['provider']
    )
  },
  swap: {
    settledAt: 'number',
    reclaimedAt: 'number',
    expiresAt: 'number',
    expiryTriggeredAt: 'number',
    orderId: 'identifier',
    slippageBps: 'number',
    autoConsume: 'boolean'
  },
  'bridged-send': {
    agglayerRoute,
    intentNonce: 'string',
    outputAmount: 'string',
    outputSymbol: 'string',
    epochStatus: 'string',
    reclaimHeight: 'number',
    reclaimNoteId: 'string',
    submitClaimed: 'boolean',
    usdcxBurn: fields(
      {
        noteId: 'string',
        destinationDomain: 'number',
        destinationUsdc: 'string',
        phase: 'string',
        confirmedAt: 'number',
        destinationBalanceConfirmed: fields({ balance: 'decimal', blockNumber: 'decimal' }, ['balance', 'blockNumber']),
        payout: fields({ transactionHash: 'string', blockNumber: 'decimal', value: 'decimal' }, [
          'transactionHash',
          'blockNumber',
          'value'
        ])
      },
      ['noteId', 'destinationDomain', 'phase']
    )
  },
  'bridged-receive': {
    oneClick,
    agglayerRoute,
    agglayerDelivery: fields({ originToken: 'string', faucetId: 'string', scale: 'number' }, ['originToken']),
    cctp: fields(
      {
        sourceDomain: 'number',
        receiptBurnAttested: 'boolean',
        executeTxHash: 'string',
        revertedExecuteTxHash: 'string',
        stalledExecuteTxHash: 'string',
        forwarded: 'boolean',
        forwardFee: 'decimal',
        forwardState: 'string'
      },
      ['sourceDomain']
    ),
    epochLockedDeposit: fields(
      {
        sponsorAddress: 'string',
        chainId: 'number',
        tokenAddress: 'string',
        isNative: 'boolean',
        amount: 'decimal',
        lockedAt: 'number',
        withdrawEnabledAt: 'number',
        withdrawableAt: 'number',
        withdrawTxHash: 'string',
        withdrawnAmount: 'decimal',
        withdrawnAt: 'number',
        emptiedAt: 'number',
        reallocatedAt: 'number'
      },
      ['sponsorAddress', 'chainId']
    )
  },
  'earn-deposit': { sourceFaucetId: 'string', outputAmount: 'string', outputSymbol: 'string' },
  'earn-withdraw': {
    sourceAmount: 'string',
    sourceSymbol: 'string',
    sourceDecimals: 'number',
    destinationFaucetId: 'string',
    outputAmount: 'string',
    outputSymbol: 'string',
    submissionAttemptId: 'string',
    error: 'string'
  },
  'switch-guardian': { commitUnconfirmed: 'boolean', registerFailed: 'boolean', endpointPersistFailed: 'boolean' },
  'replace-hot-key': { newHotPublicKey: 'string', guardianEndpoint: 'string', reRegisterFailed: 'boolean' },
  'update-procedure-threshold': { procedure: 'string', threshold: 'number' },
  'register-name': {
    label: 'string',
    network: 'string',
    registrationNoteId: 'string',
    reclaimHeight: 'number',
    builtAtBlock: 'number',
    priceBaseUnits: 'decimal',
    networkFeeBaseUnits: 'decimal',
    phase: 'string',
    failure: 'string',
    lastError: 'string',
    deliveryNoteId: 'string',
    claimTxId: 'string',
    deliveryScanFrom: 'number',
    phaseUpdatedAt: 'number'
  }
};

function readField(field: Field, value: ReceiptInput | undefined): ReceiptValue | undefined {
  if (typeof field === 'string') {
    switch (field) {
      case 'decimal':
        return typeof value === 'string' && /^\d{1,78}$/.test(value) ? value : undefined;
      case 'number':
        return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
      case 'identifier':
        return typeof value === 'string' || typeof value === 'bigint' ? value.toString() : undefined;
      case 'boolean':
        return typeof value === 'boolean' ? value : undefined;
      case 'string':
        return typeof value === 'string' ? value : undefined;
    }
  }
  if ('list' in field) {
    return Array.isArray(value)
      ? value.flatMap(item => {
          const read = readField(field.list, item);
          return read === undefined ? [] : [read];
        })
      : undefined;
  }
  if ('byNoteId' in field) {
    if (!isRecord(value)) return undefined;
    const entries: ReceiptFields = {};
    for (const [noteId, item] of Object.entries(value)) {
      const read = NOTE_ID_KEY.test(noteId) ? readEntry(field.byNoteId, item) : undefined;
      if (read !== undefined) entries[noteId] = read;
    }
    return Object.keys(entries).length > 0 ? entries : undefined;
  }
  const result = readFields(field.fields, value);
  if (result === undefined || field.required?.some(key => result[key] === undefined)) return undefined;
  return result;
}

function readFields(shape: Shape, value: ReceiptInput | undefined): ReceiptFields | undefined {
  if (!isRecord(value)) return undefined;
  const result: ReceiptFields = {};
  for (const [key, field] of Object.entries(shape)) {
    const read = readEntry(field, value[key]);
    if (read !== undefined) result[key] = read;
  }
  return result;
}

/** Read one value of a record. A value of a type that no field has reads as absent. */
function readEntry(field: Field, input: unknown): ReceiptValue | undefined {
  switch (typeof input) {
    case 'string':
    case 'number':
    case 'boolean':
    case 'bigint':
      return readField(field, input);
    case 'object':
      return input === null ? undefined : readField(field, input);
    default:
      return undefined;
  }
}

/** Copy receipt fields from a local row or validate the same fields from a backup. */
export function readReceiptExtra(type: ITransactionType, value: object | undefined): ReceiptFields | undefined {
  const result = readFields(receiptFields[type], value);
  if (type === 'bridged-receive' && isRecord(value) && isRecord(value.cctp) && isRecord(result?.cctp)) {
    if (typeof value.cctp.attestation === 'string') result.cctp.receiptBurnAttested = true;
  }
  return result && Object.keys(result).length > 0 ? result : undefined;
}
