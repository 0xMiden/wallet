import { earnReceiptRow, oneClickReceiptRow } from './testing/provider-receipts';
import { projectRecoveryTransaction } from './transaction-record';

jest.mock('@miden-sdk/miden-sdk', () => ({
  AccountId: { fromHex: (value: string) => ({ toString: () => value }) }
}));

it('Task4C2 projection preserves the complete OneClick binding and status response', () => {
  const row = oneClickReceiptRow();
  expect(projectRecoveryTransaction(row).extraInputs?.oneClick).toEqual(row.extraInputs.oneClick);
});

it('Task4C2 projection preserves prepared withdrawal siblings and the selected attempt identity', () => {
  const row = earnReceiptRow();
  expect(projectRecoveryTransaction(row).extraInputs).toEqual(row.extraInputs);
});

it('Task4C2 projection preserves pinned AggLayer delivery and USDCx source target bindings', () => {
  const row = oneClickReceiptRow();
  delete row.extraInputs.oneClick;
  row.extraInputs.provider = 'agglayer';
  row.extraInputs.agglayerDelivery = {
    originToken: '0x1111111111111111111111111111111111111111',
    faucetId: row.faucetId,
    scale: 12
  };
  expect(projectRecoveryTransaction(row).extraInputs).toEqual(row.extraInputs);
  row.extraInputs.provider = 'usdcx';
  delete row.extraInputs.agglayerDelivery;
  const chain = {
    id: 1,
    name: 'Ethereum',
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: ['https://rpc.example'] } }
  };
  const address = '0x1111111111111111111111111111111111111111';
  row.extraInputs.usdcxSource = {
    route: 'cctp-executor',
    chain,
    usdc: address,
    domain: 0,
    midenDomain: 11,
    tokenMessengerWithFees: address,
    irisApi: 'https://iris.example',
    target: {
      chain: { ...chain, id: 5042 },
      domain: 26,
      midenDomain: 11,
      executor: address,
      handler: address,
      xReserve: address,
      usdc: address,
      attestationApi: 'https://attestation.example',
      irisApi: 'https://iris.example'
    }
  };
  expect(projectRecoveryTransaction(row).extraInputs).toEqual(row.extraInputs);
});

it('Task4C2 projection rejects a mismatched prepared withdrawal identity', () => {
  const row = earnReceiptRow();
  row.extraInputs.preparedExecution.delivery.nonce = '999';
  expect(() => projectRecoveryTransaction(row)).toThrow();
});

it('Task4C2 finalseams preserves an unresolved AggLayer delivery without inventing its faucet', () => {
  const row = oneClickReceiptRow();
  delete row.extraInputs.oneClick;
  row.extraInputs.provider = 'agglayer';
  row.faucetId = '';
  expect(() => projectRecoveryTransaction(row)).not.toThrow();
  expect(projectRecoveryTransaction(row).faucetId).toBe('');
});

it.each(['quote-account', 'quote-recipient', 'status-correlation', 'allocation-request', 'oversized-attestation'])(
  'Task4C2 typed receipts reject invalid %s evidence before journal mutation',
  field => {
    const row = field === 'allocation-request' ? earnReceiptRow() : oneClickReceiptRow();
    if (field === 'quote-account') row.extraInputs.oneClick.accountId = 'another-account';
    if (field === 'quote-recipient') row.extraInputs.oneClick.request.recipient = 'another-recipient';
    if (field === 'status-correlation') row.extraInputs.oneClick.statusResponse.correlationId = 'another-quote';
    if (field === 'allocation-request')
      row.extraInputs.preparedExecution.allocations[0].requestJson = 'x'.repeat(1_000_001);
    if (field === 'oversized-attestation')
      row.extraInputs.cctp = { sourceDomain: 1, message: '0x12', attestation: 'x'.repeat(100001) };
    expect(() => projectRecoveryTransaction(row)).toThrow();
  }
);
