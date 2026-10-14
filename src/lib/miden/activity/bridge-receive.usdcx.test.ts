import { BridgedReceiveTransaction, IBridgedReceiveExtraInputs } from 'lib/miden/db/types';
import * as Repo from 'lib/miden/repo';
import type { BridgeConfigSnapshot } from 'lib/remote-config/runtime';
import { testBridgeSnapshot } from 'lib/remote-config/testing/fixture';
import vectors from 'lib/usdcx/attestation.vectors.json';
import { usdcxSourceChains } from 'lib/usdcx/constant';

import { BRIDGE_DELIVERY_TIMED_OUT } from './bridge-in';
import { reconcileBridgedReceives } from './bridge-receive';

// The published testnet document unless a test moved it.
let mockSnapshot: BridgeConfigSnapshot | undefined;
jest.mock('lib/remote-config/runtime', () => ({
  getBridgeConfigSnapshot: () =>
    mockSnapshot ??
    jest
      .requireActual<typeof import('lib/remote-config/testing/fixture')>('lib/remote-config/testing/fixture')
      .testBridgeSnapshot()
}));

// Circle attested deposit 0x370bf19a (attestation.vectors.json) to Miden account 0x8da911727d5b53916f2c221c00c091,
// 2000 USDC as the USDCx faucet 0x4cbdcaffe75f0a317482224dae6436. Real attestation decode and match, real writer and
// store; only the SDK's id parse, Circle's API and the Arc receipt read are stood in for.
const DEPOSIT_HASH = '0x370bf19aefa34f6f07d7b731d5b5f323a364c6f4116a22768d4e44a16ffeca4d';
const ATTESTED_ACCOUNT = 'mtst1attestedaccount00000000000';
const OTHER_ACCOUNT = 'mtst1otheraccount00000000000000';
const USDCX_FAUCET = 'mtst1usdcxfaucet000000000000000';
const ATTESTED_RECIPIENT = '0x000000000000000000000000000000008da911727d5b53916f2c221c00c09100';

jest.mock('@miden-sdk/miden-sdk/lazy', () => ({
  ...jest.requireActual('@miden-sdk/miden-sdk/lazy'),
  Address: {
    fromBech32: (address: string) => {
      const known: Record<string, string> = {
        mtst1attestedaccount00000000000: '0x8da911727d5b53916f2c221c00c091',
        mtst1otheraccount00000000000000: '0x0123456789abcdef0123456789ab00',
        mtst1usdcxfaucet000000000000000: '0x4cbdcaffe75f0a317482224dae6436'
      };
      const hex = known[address];
      if (hex === undefined) throw new Error(`invalid bech32 address: ${address}`);
      return { accountId: () => ({ toString: () => hex }) };
    }
  }
}));
const mockReadOutcome = jest.fn();
jest.mock('lib/walletconnect/receipt', () => ({
  waitForEvmReceipt: jest.fn(),
  readEvmReceiptOutcome: (...args: unknown[]) => mockReadOutcome(...args)
}));

const fetchMock = jest.fn();
Object.defineProperty(globalThis, 'fetch', { value: fetchMock, writable: true, configurable: true });

const addDeposit = async (
  accountId: string,
  extra: Partial<IBridgedReceiveExtraInputs> & { sourceChainId: number }
): Promise<string> => {
  const row = new BridgedReceiveTransaction(
    accountId,
    2_000_000_000n,
    USDCX_FAUCET,
    'usdcx',
    '0xe88f781e6cc8b7496f259200b57e22cb9457ff99',
    '2000',
    'USDC'
  );
  row.extraInputs = { ...row.extraInputs, phase: 'delivering', evmTxHash: DEPOSIT_HASH, ...extra };
  await Repo.transactions.add(row);
  return row.id;
};
const phaseOf = async (id: string) => (await Repo.transactions.get(id))?.extraInputs;

beforeEach(async () => {
  jest.clearAllMocks();
  mockSnapshot = undefined;
  await Repo.transactions.clear();
  fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => vectors });
  mockReadOutcome.mockResolvedValue('pending');
});

describe('a direct USDCx deposit', () => {
  it('becomes ready when Circle attested it to the account the row belongs to', async () => {
    const id = await addDeposit(ATTESTED_ACCOUNT, { sourceChainId: 5042002 });

    await reconcileBridgedReceives();

    expect(fetchMock).toHaveBeenCalledWith(
      `https://xreserve-api-testnet.circle.com/v1/attestations?txHash=${DEPOSIT_HASH}`,
      expect.anything()
    );
    expect(await phaseOf(id)).toMatchObject({ phase: 'ready' });
  });

  it('fails, and never reads ready, when Circle attested it to another Miden account', async () => {
    const id = await addDeposit(OTHER_ACCOUNT, { sourceChainId: 5042002 });

    await reconcileBridgedReceives();

    const row = await Repo.transactions.get(id);
    expect(row?.extraInputs).toMatchObject({ phase: 'failed' });
    expect(row?.error).toBe('Circle attested this deposit to a different Miden account.');
  });

  it('compares the recipient the deposit signed before the one its account derives', async () => {
    const id = await addDeposit(OTHER_ACCOUNT, { sourceChainId: 5042002, usdcxRemoteRecipient: ATTESTED_RECIPIENT });

    await reconcileBridgedReceives();

    expect(await phaseOf(id)).toMatchObject({ phase: 'ready' });
  });
});

describe('an executor-route USDCx deposit', () => {
  // The row's Arc execute hash is the xReserve deposit Circle attests; here it is the captured deposit, attested to
  // another account than the row's.
  const executorDeposit = (accountId: string) =>
    addDeposit(accountId, { sourceChainId: 84532, cctp: { sourceDomain: 6, executeTxHash: DEPOSIT_HASH } });

  it('never becomes ready on an execute Circle attested to another recipient, and warns once', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const id = await executorDeposit(OTHER_ACCOUNT);

    await reconcileBridgedReceives();
    await reconcileBridgedReceives();

    expect(await phaseOf(id)).toMatchObject({ phase: 'delivering' });
    expect(warn.mock.calls.filter(([message]) => String(message).includes('USDCx execute attestation'))).toHaveLength(
      1
    );
    expect(mockReadOutcome).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('becomes ready on an execute Circle attested to the row', async () => {
    const id = await executorDeposit(ATTESTED_ACCOUNT);

    await reconcileBridgedReceives();

    expect(await phaseOf(id)).toMatchObject({ phase: 'ready' });
  });

  it('keeps a week-old attested, unexecuted message open by the route it saved after its chain leaves the document', async () => {
    const usdcxSource = usdcxSourceChains().get(84532);
    expect(usdcxSource?.route).toBe('cctp-executor');
    const cctp = { sourceDomain: 6, message: '0x01', attestation: '0x02' };
    const id = await addDeposit(ATTESTED_ACCOUNT, { sourceChainId: 84532, usdcxSource, cctp });
    await Repo.transactions.update(id, { initiatedAt: Math.floor(Date.now() / 1000) - 8 * 24 * 60 * 60 });
    const published = testBridgeSnapshot();
    const { 'base-sepolia': _left, ...chains } = published.config?.supportedEvmChains ?? {};
    mockSnapshot = published.config
      ? { ...published, config: { ...published.config, supportedEvmChains: chains } }
      : undefined;
    expect(usdcxSourceChains().has(84532)).toBe(false);

    await reconcileBridgedReceives();

    const row = await Repo.transactions.get(id);
    expect(row?.extraInputs).toMatchObject({ phase: 'delivering', cctp });
    expect(row?.error).not.toBe(BRIDGE_DELIVERY_TIMED_OUT);
  });
});
