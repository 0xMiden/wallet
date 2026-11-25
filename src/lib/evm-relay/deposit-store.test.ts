import { readPendingSubmission, relayPendingKey, type RelayPendingSubmission } from './deposit-store';

const RECORD: RelayPendingSubmission = {
  body: {
    chainId: 11155111,
    kind: 'agglayer-deposit',
    evmAddress: '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266',
    params: {
      token: '0x2bb4ffd7e2c6d432b697554efd77fa13bdbefd69',
      amount: '2499000',
      midenAccountHex: `0x${'0a'.repeat(15)}`,
      fee: '1000'
    },
    batchNonce: '123',
    salt: `0x${'5a'.repeat(32)}`,
    deadline: 1_800_003_600,
    signature: `0x${'11'.repeat(65)}`,
    authorization: {
      address: '0x00000cabfc76478c1537dd418ab00967cbbe4ae6',
      chainId: 11155111,
      nonce: 4,
      r: `0x${'22'.repeat(32)}`,
      s: `0x${'33'.repeat(32)}`,
      yParity: 1
    }
  },
  feeRecipient: '0x3333333333333333333333333333333333333333',
  digest: `0x${'1d'.repeat(32)}`,
  row: {
    accountId: 'mtst1account',
    sourceAddress: '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266',
    chainId: 11155111,
    token: '0x2bb4ffd7e2c6d432b697554efd77fa13bdbefd69',
    amount: '2499000',
    sourceAmount: '2.499',
    sourceSymbol: 'USDC',
    outputAmount: '2.499',
    outputSymbol: 'USDC',
    agglayerRoute: {
      chainId: 11155111,
      contractAddress: '0x528e26b25a34a4a5d0dbda1d57d318153d2ed582',
      midenBridgeId: 'mtst1bridge',
      indexerUrl: 'https://indexer.example',
      rollupId: 73,
      evmNetworkId: 0,
      nativeEthFaucetId: '0x7c6d1dc7fb7045913d524bbef017f5',
      nativeEthScale: 10
    },
    agglayerDelivery: { originToken: '0x2bb4ffd7e2c6d432b697554efd77fa13bdbefd69', faucetId: '0xfaucet', scale: 0 }
  }
};

describe('readPendingSubmission', () => {
  it('reads back a stored record', () => {
    const stored: unknown = JSON.parse(JSON.stringify(RECORD));
    expect(readPendingSubmission(stored)).toEqual(RECORD);
  });

  it('reads a sponsored record with no authorization and no delivery', () => {
    const { authorization: _authorization, ...body } = RECORD.body;
    const { agglayerDelivery: _delivery, ...row } = RECORD.row;
    const sponsored = { ...RECORD, body: { ...body, params: { ...body.params, fee: '0' } }, feeRecipient: null, row };
    expect(readPendingSubmission(JSON.parse(JSON.stringify(sponsored)))).toEqual(sponsored);
  });

  it('refuses a value that is not a record', () => {
    expect(readPendingSubmission(null)).toBeNull();
    expect(readPendingSubmission({ ...RECORD, digest: '0x12' })).toBeNull();
    expect(readPendingSubmission({ ...RECORD, feeRecipient: 'nobody' })).toBeNull();
    expect(readPendingSubmission({ ...RECORD, body: { ...RECORD.body, batchNonce: '-1' } })).toBeNull();
    expect(readPendingSubmission({ ...RECORD, body: { ...RECORD.body, kind: 'other' } })).toBeNull();
    expect(readPendingSubmission({ ...RECORD, row: { ...RECORD.row, amount: 2499000 } })).toBeNull();
  });

  it('keys the record by account and chain', () => {
    expect(relayPendingKey('mtst1account', 8453)).toBe('relay_pending_v1:mtst1account:8453');
  });
});
