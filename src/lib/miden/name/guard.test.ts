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
  assertMidenNamePublishLive,
  assertMidenNameRegistrationLive,
  assertRegistrationPreconditions,
  MIDEN_NAME_RECLAIM_SAFETY_BLOCKS
} from './guard';
import { REGISTRY_SCRIPT_ROOT_HEX } from './note-script-roots';
import type { MidenNameQuote } from './reads';

jest.mock('lib/miden-chain/effective-endpoints', () => ({ getEffectiveNetworkName: jest.fn() }));
jest.mock('./reads', () => ({
  fetchMidenNameQuote: jest.fn(),
  fetchRegistryScriptAllowed: jest.fn(),
  getChainTip: jest.fn()
}));
jest.mock('./script', () => ({ loadRegisterDomainScript: jest.fn(), loadRegistryNoteScript: jest.fn() }));

const mockNetwork = jest.mocked(getEffectiveNetworkName);
const reads = jest.requireMock<{
  fetchMidenNameQuote: jest.Mock<Promise<MidenNameQuote>, [string, { fresh?: boolean }]>;
  fetchRegistryScriptAllowed: jest.Mock<Promise<boolean>, [string]>;
  getChainTip: jest.Mock<Promise<number>, []>;
}>('./reads');
const scripts = jest.requireMock<{
  loadRegisterDomainScript: jest.Mock<Promise<{ free: () => void }>, []>;
  loadRegistryNoteScript: jest.Mock<Promise<{ free: () => void }>, []>;
}>('./script');
const mockLoadScript = scripts.loadRegisterDomainScript;
const mockLoadRegistryScript = scripts.loadRegistryNoteScript;

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
  mockLoadScript.mockResolvedValue({ free: scriptFree });
  mockLoadRegistryScript.mockResolvedValue({ free: scriptFree });
  reads.fetchRegistryScriptAllowed.mockResolvedValue(true);
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
    mockLoadScript.mockRejectedValue(new MidenNameScriptMismatchError('0xa', '0xb'));
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
    await expect(
      assertMidenNameRegistrationLive(registerRow({ ...LIVE_INPUTS, reclaimHeight: '1300' }))
    ).rejects.toBeInstanceOf(MidenNameRegistrationInputError);
  });
});

describe('assertMidenNamePublishLive', () => {
  const PUBLISH_INPUTS = {
    label: 'alice',
    network: MIDEN_NETWORK_NAME.TESTNET,
    reclaimHeight: 1300
  };

  function publishRow(extraInputs?: object): ITransaction {
    return {
      id: 'pub-1',
      type: 'publish-name-record',
      accountId: 'acc-1',
      status: ITransactionStatus.GeneratingTransaction,
      initiatedAt: 1,
      displayIcon: 'SEND',
      ...(extraInputs ? { extraInputs } : {})
    };
  }

  it('passes for a live publish and checks the registry script', async () => {
    await expect(assertMidenNamePublishLive(publishRow(PUBLISH_INPUTS))).resolves.toBeUndefined();
    expect(reads.fetchRegistryScriptAllowed).toHaveBeenCalledWith(REGISTRY_SCRIPT_ROOT_HEX);
    expect(mockLoadRegistryScript).toHaveBeenCalledTimes(1);
    expect(scriptFree).toHaveBeenCalledTimes(1);
    // A publish reads no quote: the name is already issued.
    expect(reads.fetchMidenNameQuote).not.toHaveBeenCalled();
  });

  it('fails when the tip is at the reclaim safety margin', async () => {
    reads.getChainTip.mockResolvedValue(1300 - MIDEN_NAME_RECLAIM_SAFETY_BLOCKS);
    await expect(assertMidenNamePublishLive(publishRow(PUBLISH_INPUTS))).rejects.toBeInstanceOf(
      MidenNameRegistrationExpiredError
    );
  });

  it('passes one block before the reclaim safety margin', async () => {
    reads.getChainTip.mockResolvedValue(1300 - MIDEN_NAME_RECLAIM_SAFETY_BLOCKS - 1);
    await expect(assertMidenNamePublishLive(publishRow(PUBLISH_INPUTS))).resolves.toBeUndefined();
  });

  it('fails when the registry does not allow the registry script', async () => {
    reads.fetchRegistryScriptAllowed.mockResolvedValue(false);
    await expect(assertMidenNamePublishLive(publishRow(PUBLISH_INPUTS))).rejects.toBeInstanceOf(
      MidenNameScriptNotAllowedError
    );
    expect(mockLoadRegistryScript).not.toHaveBeenCalled();
    expect(reads.getChainTip).not.toHaveBeenCalled();
  });

  it('fails when the vendored registry script has an other root', async () => {
    mockLoadRegistryScript.mockRejectedValue(new MidenNameScriptMismatchError('0xa', '0xb', 'registry'));
    await expect(assertMidenNamePublishLive(publishRow(PUBLISH_INPUTS))).rejects.toBeInstanceOf(
      MidenNameScriptMismatchError
    );
    expect(reads.getChainTip).not.toHaveBeenCalled();
  });

  it('fails for an invalid label with no RPC', async () => {
    await expect(assertMidenNamePublishLive(publishRow({ ...PUBLISH_INPUTS, label: 'Bad!' }))).rejects.toBeInstanceOf(
      MidenNameInvalidLabelError
    );
    expect(reads.fetchRegistryScriptAllowed).not.toHaveBeenCalled();
  });

  it('fails when the effective network has no deployment', async () => {
    mockNetwork.mockReturnValue(MIDEN_NETWORK_NAME.DEVNET);
    await expect(assertMidenNamePublishLive(publishRow(PUBLISH_INPUTS))).rejects.toBeInstanceOf(
      MidenNameUnsupportedNetworkError
    );
    expect(reads.fetchRegistryScriptAllowed).not.toHaveBeenCalled();
  });

  it('fails when the row is for an other network', async () => {
    await expect(
      assertMidenNamePublishLive(publishRow({ ...PUBLISH_INPUTS, network: MIDEN_NETWORK_NAME.DEVNET }))
    ).rejects.toBeInstanceOf(MidenNameUnsupportedNetworkError);
  });

  it.each<[string, object | undefined]>([
    ['no extraInputs', undefined],
    ['no label', { network: MIDEN_NETWORK_NAME.TESTNET, reclaimHeight: 1300 }],
    ['no network', { label: 'alice', reclaimHeight: 1300 }],
    ['no reclaim height', { label: 'alice', network: MIDEN_NETWORK_NAME.TESTNET }],
    ['a reclaim height that is not a safe integer', { ...PUBLISH_INPUTS, reclaimHeight: 1.5 }]
  ])('fails for a row with %s', async (_name, extraInputs) => {
    await expect(assertMidenNamePublishLive(publishRow(extraInputs))).rejects.toBeInstanceOf(
      MidenNameRegistrationInputError
    );
    expect(reads.fetchRegistryScriptAllowed).not.toHaveBeenCalled();
  });
});
