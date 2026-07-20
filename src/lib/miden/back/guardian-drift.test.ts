jest.mock('../sdk/miden-client', () => ({
  getMidenClient: jest.fn(),
  withWasmClientLock: (fn: () => unknown) => fn()
}));
jest.mock('lib/miden/guardian/operator-map', () => ({
  identifyGuardianOperator: jest.fn(),
  verifyEndpointMatchesCommitment: jest.fn()
}));
jest.mock('lib/miden/guardian/account', () => ({
  getGuardianCommitmentFromAccount: jest.fn()
}));

import { resolveGuardianDrift } from './guardian-drift';
import { getMidenClient } from '../sdk/miden-client';
import { identifyGuardianOperator } from 'lib/miden/guardian/operator-map';
import { getGuardianCommitmentFromAccount } from 'lib/miden/guardian/account';

const makeVault = (acc: Record<string, unknown> | undefined) => ({
  getAccount: jest.fn(async () => acc),
  setGuardianEndpoint: jest.fn(),
  setGuardianOperatorCommitment: jest.fn(),
  setGuardianSyncStatus: jest.fn()
});

beforeEach(() => {
  jest.clearAllMocks();
  (getMidenClient as jest.Mock).mockResolvedValue({ getAccount: jest.fn(async () => ({})) });
});

it('stays in-sync when on-chain commitment equals the stored baseline', async () => {
  (getGuardianCommitmentFromAccount as jest.Mock).mockReturnValue('abc');
  const vault = makeVault({ publicKey: 'pk', guardianOperatorCommitment: 'abc' });

  expect(await resolveGuardianDrift(vault as never, 'pk')).toBe('in-sync');

  expect(vault.setGuardianSyncStatus).not.toHaveBeenCalled();
  expect(vault.setGuardianEndpoint).not.toHaveBeenCalled();
  expect(vault.setGuardianOperatorCommitment).not.toHaveBeenCalled();
  expect(identifyGuardianOperator).not.toHaveBeenCalled();
});

it('stays in-sync (case/prefix-insensitive) when the baseline matches modulo 0x-prefix and case', async () => {
  (getGuardianCommitmentFromAccount as jest.Mock).mockReturnValue('0xABC123');
  const vault = makeVault({ publicKey: 'pk', guardianOperatorCommitment: 'abc123' });

  expect(await resolveGuardianDrift(vault as never, 'pk')).toBe('in-sync');

  expect(vault.setGuardianSyncStatus).not.toHaveBeenCalled();
});

it('auto-resolves to the matching built-in operator on drift', async () => {
  (getGuardianCommitmentFromAccount as jest.Mock).mockReturnValue('newC');
  (identifyGuardianOperator as jest.Mock).mockResolvedValue({ id: 'gateway', endpoint: 'https://g' });
  const vault = makeVault({ publicKey: 'pk', guardianOperatorCommitment: 'oldC' });

  expect(await resolveGuardianDrift(vault as never, 'pk')).toBe('in-sync');

  expect(vault.setGuardianSyncStatus).toHaveBeenNthCalledWith(1, 'pk', 'resolving');
  expect(vault.setGuardianEndpoint).toHaveBeenCalledWith('pk', 'https://g');
  expect(vault.setGuardianOperatorCommitment).toHaveBeenCalledWith('pk', 'newC');
  expect(vault.setGuardianSyncStatus).toHaveBeenLastCalledWith('pk', 'in-sync');
});

it('auto-resolves on first-ever check, when no baseline commitment is stored yet', async () => {
  (getGuardianCommitmentFromAccount as jest.Mock).mockReturnValue('newC');
  (identifyGuardianOperator as jest.Mock).mockResolvedValue({ id: 'gateway', endpoint: 'https://g' });
  const vault = makeVault({ publicKey: 'pk' });

  expect(await resolveGuardianDrift(vault as never, 'pk')).toBe('in-sync');

  expect(vault.setGuardianEndpoint).toHaveBeenCalledWith('pk', 'https://g');
  expect(vault.setGuardianOperatorCommitment).toHaveBeenCalledWith('pk', 'newC');
  expect(vault.setGuardianSyncStatus).toHaveBeenLastCalledWith('pk', 'in-sync');
});

it('flags needs-user-input when no built-in operator matches', async () => {
  (getGuardianCommitmentFromAccount as jest.Mock).mockReturnValue('customC');
  (identifyGuardianOperator as jest.Mock).mockResolvedValue(undefined);
  const vault = makeVault({ publicKey: 'pk', guardianOperatorCommitment: 'oldC' });

  expect(await resolveGuardianDrift(vault as never, 'pk')).toBe('needs-user-input');

  expect(vault.setGuardianSyncStatus).toHaveBeenNthCalledWith(1, 'pk', 'resolving');
  expect(vault.setGuardianSyncStatus).toHaveBeenLastCalledWith('pk', 'needs-user-input');
  expect(vault.setGuardianEndpoint).not.toHaveBeenCalled();
  expect(vault.setGuardianOperatorCommitment).not.toHaveBeenCalled();
});

it('returns in-sync without any reads or writes when the account is not in the vault', async () => {
  const vault = makeVault(undefined);

  expect(await resolveGuardianDrift(vault as never, 'missing-pk')).toBe('in-sync');

  expect(getMidenClient).not.toHaveBeenCalled();
  expect(vault.setGuardianSyncStatus).not.toHaveBeenCalled();
});

it('returns in-sync without writes when the account has no on-chain SDK record', async () => {
  (getMidenClient as jest.Mock).mockResolvedValue({ getAccount: jest.fn(async () => undefined) });
  const vault = makeVault({ publicKey: 'pk', guardianOperatorCommitment: 'abc' });

  expect(await resolveGuardianDrift(vault as never, 'pk')).toBe('in-sync');

  expect(getGuardianCommitmentFromAccount).not.toHaveBeenCalled();
  expect(vault.setGuardianSyncStatus).not.toHaveBeenCalled();
});

it('returns in-sync without writes when the on-chain account has no guardian commitment', async () => {
  (getGuardianCommitmentFromAccount as jest.Mock).mockReturnValue(undefined);
  const vault = makeVault({ publicKey: 'pk', guardianOperatorCommitment: 'abc' });

  expect(await resolveGuardianDrift(vault as never, 'pk')).toBe('in-sync');

  expect(vault.setGuardianSyncStatus).not.toHaveBeenCalled();
});
