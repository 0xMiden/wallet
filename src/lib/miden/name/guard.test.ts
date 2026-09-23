import { ITransactionStatus, type ITransaction } from 'lib/miden/db/types';
import { getEffectiveNetworkName } from 'lib/miden-chain/effective-endpoints';
import { MIDEN_NETWORK_NAME } from 'lib/miden-chain/networks-config';

import {
  MidenNameInvalidLabelError,
  MidenNamePriceChangedError,
  MidenNameRegistrationExpiredError,
  MidenNameRegistrationInputError,
  MidenNameScriptMismatchError,
  MidenNameScriptNotAllowedError,
  MidenNameTakenError,
  MidenNameUnsupportedNetworkError
} from './errors';
import {
  assertMidenNameRegistrationLive,
  assertRegistrationPreconditions,
  MIDEN_NAME_RECLAIM_SAFETY_BLOCKS
} from './guard';
import type { MidenNameQuote } from './reads';

jest.mock('lib/miden-chain/effective-endpoints', () => ({ getEffectiveNetworkName: jest.fn() }));
jest.mock('./reads', () => ({ fetchMidenNameQuote: jest.fn(), getChainTip: jest.fn() }));
jest.mock('./script', () => ({ loadRegisterDomainScript: jest.fn() }));

const mockNetwork = jest.mocked(getEffectiveNetworkName);
const reads = jest.requireMock<{
  fetchMidenNameQuote: jest.Mock<Promise<MidenNameQuote>, [string, { fresh?: boolean }]>;
  getChainTip: jest.Mock<Promise<number>, []>;
}>('./reads');
const mockLoadScript = jest.requireMock<{ loadRegisterDomainScript: jest.Mock<{ free: () => void }, []> }>(
  './script'
).loadRegisterDomainScript;

const PRICE = 20_000_000n;
const scriptFree = jest.fn();

function quote(overrides: Partial<MidenNameQuote> = {}): MidenNameQuote {
  return {
    label: 'alice',
    available: true,
    priceBaseUnits: PRICE,
    networkFeeBaseUnits: 210n,
    scriptAllowed: true,
    blockNum: 1000,
    ...overrides
  };
}

function registerRow(extraInputs: object): ITransaction {
  return {
    id: 'reg-1',
    type: 'register-name',
    accountId: 'acc-1',
    status: ITransactionStatus.GeneratingTransaction,
    initiatedAt: 1,
    displayIcon: 'SEND',
    extraInputs
  };
}

const LIVE_INPUTS = {
  label: 'alice',
  network: MIDEN_NETWORK_NAME.TESTNET,
  priceBaseUnits: PRICE.toString(),
  reclaimHeight: 1300
};

beforeEach(() => {
  jest.clearAllMocks();
  mockNetwork.mockReturnValue(MIDEN_NETWORK_NAME.TESTNET);
  reads.fetchMidenNameQuote.mockResolvedValue(quote());
  reads.getChainTip.mockResolvedValue(1000);
  mockLoadScript.mockReturnValue({ free: scriptFree });
});

describe('assertRegistrationPreconditions', () => {
  it('reads a fresh quote and returns it when the name can be registered', async () => {
    await expect(assertRegistrationPreconditions('alice', PRICE)).resolves.toEqual(quote());
    expect(reads.fetchMidenNameQuote).toHaveBeenCalledWith('alice', { fresh: true });
    expect(mockLoadScript).toHaveBeenCalledTimes(1);
    expect(scriptFree).toHaveBeenCalledTimes(1);
  });

  it('does not compare the price when no expected price is given', async () => {
    reads.fetchMidenNameQuote.mockResolvedValue(quote({ priceBaseUnits: 1n }));
    await expect(assertRegistrationPreconditions('alice')).resolves.toBeDefined();
  });

  it('throws MidenNameTakenError when the name is issued', async () => {
    reads.fetchMidenNameQuote.mockResolvedValue(quote({ available: false }));
    await expect(assertRegistrationPreconditions('alice', PRICE)).rejects.toBeInstanceOf(MidenNameTakenError);
  });

  it('throws MidenNameScriptNotAllowedError when the registry does not allow the script', async () => {
    reads.fetchMidenNameQuote.mockResolvedValue(quote({ scriptAllowed: false }));
    await expect(assertRegistrationPreconditions('alice', PRICE)).rejects.toBeInstanceOf(
      MidenNameScriptNotAllowedError
    );
  });

  it('throws MidenNamePriceChangedError when the price changed', async () => {
    reads.fetchMidenNameQuote.mockResolvedValue(quote({ priceBaseUnits: PRICE + 1n }));
    await expect(assertRegistrationPreconditions('alice', PRICE)).rejects.toBeInstanceOf(MidenNamePriceChangedError);
  });

  it('throws when the bundled script has an other root', async () => {
    mockLoadScript.mockImplementation(() => {
      throw new MidenNameScriptMismatchError('0xa', '0xb');
    });
    await expect(assertRegistrationPreconditions('alice', PRICE)).rejects.toBeInstanceOf(MidenNameScriptMismatchError);
  });

  it('refuses an invalid label with no RPC', async () => {
    await expect(assertRegistrationPreconditions('Bad!', PRICE)).rejects.toBeInstanceOf(MidenNameInvalidLabelError);
    expect(reads.fetchMidenNameQuote).not.toHaveBeenCalled();
  });
});

describe('assertMidenNameRegistrationLive', () => {
  it('passes for a live registration', async () => {
    await expect(assertMidenNameRegistrationLive(registerRow(LIVE_INPUTS))).resolves.toBeUndefined();
    expect(reads.fetchMidenNameQuote).toHaveBeenCalledWith('alice', { fresh: true });
  });

  it('fails when the tip is at the reclaim safety margin', async () => {
    reads.getChainTip.mockResolvedValue(1300 - MIDEN_NAME_RECLAIM_SAFETY_BLOCKS);
    await expect(assertMidenNameRegistrationLive(registerRow(LIVE_INPUTS))).rejects.toBeInstanceOf(
      MidenNameRegistrationExpiredError
    );
  });

  it('passes one block before the reclaim safety margin', async () => {
    reads.getChainTip.mockResolvedValue(1300 - MIDEN_NAME_RECLAIM_SAFETY_BLOCKS - 1);
    await expect(assertMidenNameRegistrationLive(registerRow(LIVE_INPUTS))).resolves.toBeUndefined();
  });

  it('fails when the name was taken after the build', async () => {
    reads.fetchMidenNameQuote.mockResolvedValue(quote({ available: false }));
    await expect(assertMidenNameRegistrationLive(registerRow(LIVE_INPUTS))).rejects.toBeInstanceOf(MidenNameTakenError);
  });

  it('fails when the price is not the price on the row', async () => {
    reads.fetchMidenNameQuote.mockResolvedValue(quote({ priceBaseUnits: 1n }));
    await expect(assertMidenNameRegistrationLive(registerRow(LIVE_INPUTS))).rejects.toBeInstanceOf(
      MidenNamePriceChangedError
    );
  });

  it('fails when the effective network is not the network of the row', async () => {
    mockNetwork.mockReturnValue(MIDEN_NETWORK_NAME.DEVNET);
    await expect(assertMidenNameRegistrationLive(registerRow(LIVE_INPUTS))).rejects.toBeInstanceOf(
      MidenNameUnsupportedNetworkError
    );
    expect(reads.fetchMidenNameQuote).not.toHaveBeenCalled();
  });

  it('fails when the row has no usable extraInputs', async () => {
    await expect(assertMidenNameRegistrationLive(registerRow({ label: 'alice' }))).rejects.toBeInstanceOf(
      MidenNameRegistrationInputError
    );
    await expect(
      assertMidenNameRegistrationLive(registerRow({ ...LIVE_INPUTS, priceBaseUnits: 'x' }))
    ).rejects.toBeInstanceOf(MidenNameRegistrationInputError);
  });
});
