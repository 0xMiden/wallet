/** @jest-environment node */
import type { OneClickStatusResponse } from '../src/lib/one-click/types';
import { hashOneClickQuote } from '../src/lib/one-click/signature';
import { nativeNearFixture, nativeNearQuote } from './helpers/mainnet-near-fixture';

const mockState = jest.fn();
const mockSave = jest.fn();
const mockRestore = jest.fn();
const mockVault = jest.fn();
const mockStatus = jest.fn();
const mockWrite = jest.fn();
const mockGrant = jest.fn();
const mockSubmit = jest.fn();
const mockClient = { getChainId: jest.fn(), getBalance: jest.fn(), readContract: jest.fn(), getTransactionCount: jest.fn() };
jest.mock('@playwright/test', () => ({ expect }));
jest.mock('../playwright/e2e/fixtures/two-wallets', () => ({}));
jest.mock('node:fs', () => ({ ...jest.requireActual('node:fs'), writeFileSync: (...args: unknown[]) => mockWrite(...args) }));
jest.mock('viem', () => ({ ...jest.requireActual('viem'), createPublicClient: () => mockClient }));
jest.mock('../playwright/e2e/helpers/mainnet-near-checkpoint', () => ({
  ...jest.requireActual('../playwright/e2e/helpers/mainnet-near-checkpoint'),
  loadMainnetNearCheckpoint: () => mockState(),
  saveMainnetNearCheckpoint: (...args: unknown[]) => mockSave(...args)
}));
jest.mock('../playwright/e2e/helpers/mainnet-loop-wallet', () => ({ restoreMainnetLoopGuardian: (...args: unknown[]) => mockRestore(...args) }));
jest.mock('../playwright/e2e/helpers/balance-truth', () => ({ vaultBalanceByFaucetId: (...args: unknown[]) => mockVault(...args) }));
jest.mock('../src/lib/one-click/client', () => ({
  ...jest.requireActual('../src/lib/one-click/client'),
  fetchOneClickStatus: (...args: unknown[]) => mockStatus(...args),
  submitOneClickDeposit: (...args: unknown[]) => mockSubmit(...args)
}));
jest.mock('../playwright/e2e/helpers/mainnet-send-authorization', () => ({ armMainnetSendAuthorization: (...args: unknown[]) => mockGrant(...args) }));
jest.mock('../playwright/e2e/helpers/mainnet-consume-authorization', () => ({}));
jest.mock('../playwright/e2e/helpers/mainnet-one-click-ui', () => ({}));
jest.mock('../playwright/e2e/helpers/mainnet-miden-request', () => ({}));
jest.mock('../playwright/e2e/helpers/history', () => ({}));
jest.mock('../playwright/e2e/helpers/swap', () => ({}));
jest.mock('../playwright/e2e/ios/helpers/wc-counterparty', () => ({}));
import { runMainnetNearStage } from '../playwright/e2e/helpers/mainnet-near-runtime';

const env = { ...process.env };
const wallet = { getAccountAddress: jest.fn(), extensionId: 'unit-extension', page: {} };
const recover = () => Reflect.apply(runMainnetNearStage, undefined, [wallet, 'recover']);
function fixture() {
  const state = nativeNearFixture();
  state.sourceRunId = state.authorizationRunId = '43811169447';
  const quote = nativeNearQuote('mm1apeg8ae87qy4n52a2myu6kpk8c3y4mav', state.principal);
  const status: OneClickStatusResponse = {
    status: 'PENDING_DEPOSIT', correlationId: quote.correlationId, updatedAt: state.createdAt,
    swapDetails: { intentHashes: [], nearTxHashes: [], originChainTxHashes: [], destinationChainTxHashes: [] },
    quoteResponse: {
      timestamp: state.createdAt, signature: 'previously-validated-boundary', correlationId: quote.correlationId,
      quoteRequest: { dry: false, swapType: 'EXACT_INPUT', slippageTolerance: 100, originAsset: state.nativeAssetId, destinationAsset: state.evmAssetId, amount: state.principal, refundTo: state.account, refundType: 'ORIGIN_CHAIN', recipient: state.evm.account, recipientType: 'DESTINATION_CHAIN', depositType: 'ORIGIN_CHAIN', deadline: quote.deadline },
      quote: { depositAddress: quote.depositAddress, deadline: quote.deadline, amountIn: state.principal, amountInFormatted: '1.01', amountInUsd: '1.01', minAmountIn: state.principal, amountOut: '1000000', amountOutFormatted: '1', amountOutUsd: '1', minAmountOut: quote.minimumOutput, refundFee: quote.refundFee, timeEstimate: 30 }
    }
  };
  state.forwardQuote = { ...quote, quoteHash: hashOneClickQuote(status.quoteResponse) };
  return { state, status };
}
beforeEach(() => {
  jest.clearAllMocks();
  jest.useFakeTimers().setSystemTime(new Date('2026-11-16T18:30:00Z'));
  process.env.E2E_NETWORK = 'mainnet'; process.env.GITHUB_RUN_ID = '43930000000'; process.env.GITHUB_RUN_ATTEMPT = '1';
  process.env.MAINNET_NEAR_FORWARD_ATTEMPTED = 'true'; process.env.MAINNET_NEAR_PREAUTH_UNSPENT = 'true';
  process.env.E2E_MAINNET_GUARDIAN_KEY_PAIR = 'existing-original-secret';
  const {state,status}=fixture();
  mockState.mockReturnValue(state); mockStatus.mockResolvedValue(status);
  jest.mocked(wallet.getAccountAddress).mockResolvedValue(state.account);
  mockVault.mockResolvedValue(BigInt(state.native.balance)); mockClient.getChainId.mockResolvedValue(state.evm.chainId);
  mockClient.getBalance.mockResolvedValue(BigInt(state.evm.nativeBalance)); mockClient.readContract.mockResolvedValue(BigInt(state.evm.tokenBalance));
  mockClient.getTransactionCount.mockResolvedValue(84);
});
afterEach(() => { process.env = { ...env }; jest.useRealTimers(); });
function noFunding() { expect(mockGrant).not.toHaveBeenCalled(); expect(mockSubmit).not.toHaveBeenCalled(); }
it('reconciles the known expired unsigned quote after live checks, retains every authority field and forces recovery-only', async () => {
  const state = mockState(); const original = structuredClone(state);
  await expect(recover()).resolves.toBeUndefined();
  expect(mockRestore).toHaveBeenCalledTimes(1); expect(mockStatus).toHaveBeenCalledTimes(1);
  expect(mockSave).toHaveBeenCalledWith(expect.any(String), { ...original, phase: 'unspent', updatedAt: new Date().toISOString() });
  expect(mockWrite).toHaveBeenCalledWith('test-results/mainnet-near-recovery.json', expect.stringContaining('"recoveryOnly":true'));
  noFunding();
});
it.each(['false', '', undefined])('does not infer an unspent state without exact official provenance: %s', async verified => {
  if(verified===undefined)delete process.env.MAINNET_NEAR_PREAUTH_UNSPENT;else process.env.MAINNET_NEAR_PREAUTH_UNSPENT=verified;
  await expect(recover()).rejects.toThrow(); expect(mockSave).not.toHaveBeenCalled(); noFunding();
});
it.each(['native','token','gas','pending-nonce','chain','guardian','provider','quote','correlation','deposited','live-quote','live-price','wrong-source','fees'])('retains the original checkpoint on changed or unknown %s', async changed => {
  const state=mockState(); const status=await mockStatus();
  if(changed==='native')mockVault.mockResolvedValue(1n);
  if(changed==='token')mockClient.readContract.mockResolvedValue(1n);
  if(changed==='gas')mockClient.getBalance.mockResolvedValue(1n);
  if(changed==='pending-nonce')mockClient.getTransactionCount.mockResolvedValueOnce(84).mockResolvedValueOnce(85);
  if(changed==='chain')mockClient.getChainId.mockResolvedValue(1);
  if(changed==='guardian')jest.mocked(wallet.getAccountAddress).mockResolvedValue('different');
  if(changed==='provider')status.status='PROCESSING';
  if(changed==='quote')status.quoteResponse.quote.amountOut='999999';
  if(changed==='correlation')status.quoteResponse.correlationId='different';
  if(changed==='deposited')status.swapDetails.depositedAmount='1';
  if(changed==='live-quote')state.forwardQuote.deadline='2026-11-16T18:31:00Z';
  if(changed==='live-price')state.pricedAt=new Date().toISOString();
  if(changed==='wrong-source')state.sourceRunId='43811169448';
  if(changed==='fees')state.paidMidenFees='1';
  mockStatus.mockClear(); const original=JSON.stringify(state);
  await expect(recover()).rejects.toThrow();
  expect(JSON.stringify(state)).toBe(original);expect(mockSave).not.toHaveBeenCalled();noFunding();
});
