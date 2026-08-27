import { getGuardianCommitmentFromAccount } from 'lib/miden/guardian/account';
import {
  checkEndpointCommitment,
  identifyGuardianOperator,
  verifyEndpointMatchesCommitment
} from 'lib/miden/guardian/operator-map';

import { applyUserGuardianEndpoint, resolveGuardianDrift } from './guardian-drift';
import { getMidenClient } from '../sdk/miden-client';

// The slice-2 offscreen client proxy reads getAccount through the `lib/...` alias
// of miden-client, which jest mocks separately from the relative specifier below;
// delegate the alias to the same mock so the proxy's flag-off passthrough hits it.
jest.mock('lib/miden/sdk/miden-client', () => jest.requireMock('../sdk/miden-client'));
jest.mock('../sdk/miden-client', () => ({
  getMidenClient: jest.fn(),
  withWasmClientLock: (fn: () => unknown) => fn()
}));
jest.mock('lib/miden/guardian/operator-map', () => ({
  checkEndpointCommitment: jest.fn(),
  identifyGuardianOperator: jest.fn(),
  verifyEndpointMatchesCommitment: jest.fn()
}));
jest.mock('lib/miden/guardian/account', () => ({
  getGuardianCommitmentFromAccount: jest.fn()
}));

const makeVault = (acc: Record<string, unknown> | undefined) => ({
  getAccount: jest.fn(async () => acc),
  setGuardianEndpoint: jest.fn(),
  setGuardianOperatorCommitment: jest.fn(),
  setGuardianSyncStatus: jest.fn()
});

/** Attaches recording implementations so write order can be asserted. */
const trackWriteOrder = (vault: ReturnType<typeof makeVault>) => {
  const order: string[] = [];
  vault.setGuardianEndpoint.mockImplementation(async () => {
    order.push('endpoint');
  });
  vault.setGuardianOperatorCommitment.mockImplementation(async () => {
    order.push('commitment');
  });
  vault.setGuardianSyncStatus.mockImplementation(async (_pk: string, status: string) => {
    order.push(`status:${status}`);
  });
  return order;
};

beforeEach(() => {
  jest.clearAllMocks();
  (getMidenClient as jest.Mock).mockResolvedValue({ getAccount: jest.fn(async () => ({})) });
});

it('stays in-sync when on-chain commitment equals the stored baseline', async () => {
  (getGuardianCommitmentFromAccount as jest.Mock).mockReturnValue('abc');
  const vault = makeVault({ publicKey: 'pk', guardianOperatorCommitment: 'abc' });

  expect(await resolveGuardianDrift(vault as never, 'pk')).toEqual({ status: 'in-sync', changed: false });

  expect(vault.setGuardianSyncStatus).not.toHaveBeenCalled();
  expect(vault.setGuardianEndpoint).not.toHaveBeenCalled();
  expect(vault.setGuardianOperatorCommitment).not.toHaveBeenCalled();
  expect(identifyGuardianOperator).not.toHaveBeenCalled();
});

it('stays in-sync (case/prefix-insensitive) when the baseline matches modulo 0x-prefix and case', async () => {
  (getGuardianCommitmentFromAccount as jest.Mock).mockReturnValue('0xABC123');
  const vault = makeVault({ publicKey: 'pk', guardianOperatorCommitment: 'abc123' });

  expect(await resolveGuardianDrift(vault as never, 'pk')).toEqual({ status: 'in-sync', changed: false });

  expect(vault.setGuardianSyncStatus).not.toHaveBeenCalled();
});

it('auto-resolves to the matching built-in operator on drift', async () => {
  (getGuardianCommitmentFromAccount as jest.Mock).mockReturnValue('newC');
  (identifyGuardianOperator as jest.Mock).mockResolvedValue({ id: 'gateway', endpoint: 'https://g' });
  const vault = makeVault({ publicKey: 'pk', guardianOperatorCommitment: 'oldC' });

  expect(await resolveGuardianDrift(vault as never, 'pk')).toEqual({ status: 'in-sync', changed: true });

  expect(vault.setGuardianSyncStatus).toHaveBeenNthCalledWith(1, 'pk', 'resolving');
  expect(vault.setGuardianEndpoint).toHaveBeenCalledWith('pk', 'https://g');
  expect(vault.setGuardianOperatorCommitment).toHaveBeenCalledWith('pk', 'newC');
  expect(vault.setGuardianSyncStatus).toHaveBeenLastCalledWith('pk', 'in-sync');
});

it('writes the commitment baseline LAST — after status is finalized to in-sync — so a failed last write self-heals instead of sticking at resolving', async () => {
  (getGuardianCommitmentFromAccount as jest.Mock).mockReturnValue('newC');
  (identifyGuardianOperator as jest.Mock).mockResolvedValue({ id: 'gateway', endpoint: 'https://g' });
  const vault = makeVault({ publicKey: 'pk', guardianOperatorCommitment: 'oldC' });
  const order = trackWriteOrder(vault);

  expect(await resolveGuardianDrift(vault as never, 'pk')).toEqual({ status: 'in-sync', changed: true });

  expect(order).toEqual(['status:resolving', 'endpoint', 'status:in-sync', 'commitment']);
});

it('self-heals a stranded account (commitment already advanced to on-chain, but status stuck at resolving) back to in-sync', async () => {
  (getGuardianCommitmentFromAccount as jest.Mock).mockReturnValue('abc');
  const vault = makeVault({ publicKey: 'pk', guardianOperatorCommitment: 'abc', guardianSyncStatus: 'resolving' });

  expect(await resolveGuardianDrift(vault as never, 'pk')).toEqual({ status: 'in-sync', changed: true });

  expect(vault.setGuardianSyncStatus).toHaveBeenCalledTimes(1);
  expect(vault.setGuardianSyncStatus).toHaveBeenCalledWith('pk', 'in-sync');
  expect(vault.setGuardianEndpoint).not.toHaveBeenCalled();
  expect(vault.setGuardianOperatorCommitment).not.toHaveBeenCalled();
  expect(identifyGuardianOperator).not.toHaveBeenCalled();
});

it('does not write anything when the baseline matches on-chain and status is already in-sync (true no-op)', async () => {
  (getGuardianCommitmentFromAccount as jest.Mock).mockReturnValue('abc');
  const vault = makeVault({ publicKey: 'pk', guardianOperatorCommitment: 'abc', guardianSyncStatus: 'in-sync' });

  expect(await resolveGuardianDrift(vault as never, 'pk')).toEqual({ status: 'in-sync', changed: false });

  expect(vault.setGuardianSyncStatus).not.toHaveBeenCalled();
  expect(vault.setGuardianEndpoint).not.toHaveBeenCalled();
  expect(vault.setGuardianOperatorCommitment).not.toHaveBeenCalled();
});

it('auto-resolves on first-ever check, when no baseline commitment is stored yet', async () => {
  (getGuardianCommitmentFromAccount as jest.Mock).mockReturnValue('newC');
  (identifyGuardianOperator as jest.Mock).mockResolvedValue({ id: 'gateway', endpoint: 'https://g' });
  const vault = makeVault({ publicKey: 'pk' });

  expect(await resolveGuardianDrift(vault as never, 'pk')).toEqual({ status: 'in-sync', changed: true });

  expect(vault.setGuardianEndpoint).toHaveBeenCalledWith('pk', 'https://g');
  expect(vault.setGuardianOperatorCommitment).toHaveBeenCalledWith('pk', 'newC');
  expect(vault.setGuardianSyncStatus).toHaveBeenLastCalledWith('pk', 'in-sync');
});

it('flags needs-user-input when no built-in operator matches', async () => {
  (getGuardianCommitmentFromAccount as jest.Mock).mockReturnValue('customC');
  (identifyGuardianOperator as jest.Mock).mockResolvedValue(undefined);
  const vault = makeVault({ publicKey: 'pk', guardianOperatorCommitment: 'oldC' });

  expect(await resolveGuardianDrift(vault as never, 'pk')).toEqual({ status: 'needs-user-input', changed: true });

  expect(vault.setGuardianSyncStatus).toHaveBeenNthCalledWith(1, 'pk', 'resolving');
  expect(vault.setGuardianSyncStatus).toHaveBeenLastCalledWith('pk', 'needs-user-input');
  expect(vault.setGuardianEndpoint).not.toHaveBeenCalled();
  expect(vault.setGuardianOperatorCommitment).not.toHaveBeenCalled();
});

it('affirms in-sync when the STORED endpoint matches on-chain — a deliberate custom-URL switch must not flag needs-user-input', async () => {
  (getGuardianCommitmentFromAccount as jest.Mock).mockReturnValue('customC');
  (checkEndpointCommitment as jest.Mock).mockResolvedValue('match');
  const vault = makeVault({
    publicKey: 'pk',
    guardianOperatorCommitment: 'oldC',
    guardianEndpoint: 'https://custom.guardian'
  });
  const order = trackWriteOrder(vault);

  expect(await resolveGuardianDrift(vault as never, 'pk')).toEqual({ status: 'in-sync', changed: true });

  expect(checkEndpointCommitment).toHaveBeenCalledWith('https://custom.guardian', 'customC');
  // Endpoint is already correct — only status + baseline are written, commitment
  // LAST (mirroring the other branches). The stored endpoint is asked FIRST, so
  // the built-in operator fan-out is never reached on this common path.
  expect(vault.setGuardianEndpoint).not.toHaveBeenCalled();
  expect(order).toEqual(['status:in-sync', 'commitment']);
  expect(identifyGuardianOperator).not.toHaveBeenCalled();
});

it('still flags needs-user-input when the stored endpoint does NOT match on-chain (genuine out-of-band switch)', async () => {
  (getGuardianCommitmentFromAccount as jest.Mock).mockReturnValue('customC');
  (identifyGuardianOperator as jest.Mock).mockResolvedValue(undefined);
  (checkEndpointCommitment as jest.Mock).mockResolvedValue('mismatch');
  const vault = makeVault({
    publicKey: 'pk',
    guardianOperatorCommitment: 'oldC',
    guardianEndpoint: 'https://stale.guardian'
  });

  expect(await resolveGuardianDrift(vault as never, 'pk')).toEqual({ status: 'needs-user-input', changed: true });

  expect(checkEndpointCommitment).toHaveBeenCalledWith('https://stale.guardian', 'customC');
  expect(vault.setGuardianSyncStatus).toHaveBeenLastCalledWith('pk', 'needs-user-input');
  expect(vault.setGuardianOperatorCommitment).not.toHaveBeenCalled();
});

// An unanswered probe is not evidence of drift. Writing `needs-user-input` here
// would accuse an endpoint that may be exactly right, and this path re-runs on
// every ~3s sync tick — so a single outage would otherwise sit the user in front
// of a "re-enter your guardian URL" banner for its whole duration.
it('changes nothing when the stored endpoint cannot be reached, leaving the next tick to retry', async () => {
  (getGuardianCommitmentFromAccount as jest.Mock).mockReturnValue('customC');
  (checkEndpointCommitment as jest.Mock).mockResolvedValue('unreachable');
  const vault = makeVault({
    publicKey: 'pk',
    guardianOperatorCommitment: 'oldC',
    guardianEndpoint: 'https://down.guardian',
    guardianSyncStatus: 'in-sync'
  });

  expect(await resolveGuardianDrift(vault as never, 'pk')).toEqual({ status: 'in-sync', changed: false });

  // Not even the transient `resolving` marker: bailing after writing it would
  // strand the account in a status with no banner and no recovery path.
  expect(vault.setGuardianSyncStatus).not.toHaveBeenCalled();
  expect(vault.setGuardianEndpoint).not.toHaveBeenCalled();
  expect(vault.setGuardianOperatorCommitment).not.toHaveBeenCalled();
  expect(identifyGuardianOperator).not.toHaveBeenCalled();
});

it('preserves an already-flagged status when the stored endpoint cannot be reached', async () => {
  (getGuardianCommitmentFromAccount as jest.Mock).mockReturnValue('customC');
  (checkEndpointCommitment as jest.Mock).mockResolvedValue('unreachable');
  const vault = makeVault({
    publicKey: 'pk',
    guardianOperatorCommitment: 'oldC',
    guardianEndpoint: 'https://down.guardian',
    guardianSyncStatus: 'needs-user-input'
  });

  expect(await resolveGuardianDrift(vault as never, 'pk')).toEqual({
    status: 'needs-user-input',
    changed: false
  });
  expect(vault.setGuardianSyncStatus).not.toHaveBeenCalled();
});

it('returns in-sync without any reads or writes when the account is not in the vault', async () => {
  const vault = makeVault(undefined);

  expect(await resolveGuardianDrift(vault as never, 'missing-pk')).toEqual({ status: 'in-sync', changed: false });

  expect(getMidenClient).not.toHaveBeenCalled();
  expect(vault.setGuardianSyncStatus).not.toHaveBeenCalled();
});

it('returns in-sync without writes when the account has no on-chain SDK record', async () => {
  (getMidenClient as jest.Mock).mockResolvedValue({ getAccount: jest.fn(async () => undefined) });
  const vault = makeVault({ publicKey: 'pk', guardianOperatorCommitment: 'abc' });

  expect(await resolveGuardianDrift(vault as never, 'pk')).toEqual({ status: 'in-sync', changed: false });

  expect(getGuardianCommitmentFromAccount).not.toHaveBeenCalled();
  expect(vault.setGuardianSyncStatus).not.toHaveBeenCalled();
});

it('returns in-sync without writes when the on-chain account has no guardian commitment', async () => {
  (getGuardianCommitmentFromAccount as jest.Mock).mockReturnValue(undefined);
  const vault = makeVault({ publicKey: 'pk', guardianOperatorCommitment: 'abc' });

  expect(await resolveGuardianDrift(vault as never, 'pk')).toEqual({ status: 'in-sync', changed: false });

  expect(vault.setGuardianSyncStatus).not.toHaveBeenCalled();
});

describe('applyUserGuardianEndpoint', () => {
  it('persists a user URL only when it matches the on-chain commitment', async () => {
    (getGuardianCommitmentFromAccount as jest.Mock).mockReturnValue('cc');
    (verifyEndpointMatchesCommitment as jest.Mock).mockResolvedValue(true);
    const vault = makeVault({ publicKey: 'pk', guardianOperatorCommitment: 'old' });

    expect(await applyUserGuardianEndpoint(vault as never, 'pk', 'https://mine')).toBe(true);

    expect(verifyEndpointMatchesCommitment).toHaveBeenCalledWith('https://mine', 'cc');
    expect(vault.setGuardianEndpoint).toHaveBeenCalledWith('pk', 'https://mine');
    expect(vault.setGuardianOperatorCommitment).toHaveBeenCalledWith('pk', 'cc');
    expect(vault.setGuardianSyncStatus).toHaveBeenLastCalledWith('pk', 'in-sync');
  });

  it('writes the commitment baseline LAST — after status is finalized to in-sync — matching resolveGuardianDrift ordering', async () => {
    (getGuardianCommitmentFromAccount as jest.Mock).mockReturnValue('cc');
    (verifyEndpointMatchesCommitment as jest.Mock).mockResolvedValue(true);
    const vault = makeVault({ publicKey: 'pk', guardianOperatorCommitment: 'old' });
    const order = trackWriteOrder(vault);

    expect(await applyUserGuardianEndpoint(vault as never, 'pk', 'https://mine')).toBe(true);

    expect(order).toEqual(['endpoint', 'status:in-sync', 'commitment']);
  });

  it('rejects a user URL that does not match on-chain', async () => {
    (getGuardianCommitmentFromAccount as jest.Mock).mockReturnValue('cc');
    (verifyEndpointMatchesCommitment as jest.Mock).mockResolvedValue(false);
    const vault = makeVault({ publicKey: 'pk' });

    expect(await applyUserGuardianEndpoint(vault as never, 'pk', 'https://wrong')).toBe(false);

    expect(vault.setGuardianEndpoint).not.toHaveBeenCalled();
    expect(vault.setGuardianOperatorCommitment).not.toHaveBeenCalled();
    expect(vault.setGuardianSyncStatus).not.toHaveBeenCalled();
  });

  it('rejects without calling verify when the account has no on-chain guardian commitment', async () => {
    (getGuardianCommitmentFromAccount as jest.Mock).mockReturnValue(undefined);
    const vault = makeVault({ publicKey: 'pk' });

    expect(await applyUserGuardianEndpoint(vault as never, 'pk', 'https://mine')).toBe(false);

    expect(verifyEndpointMatchesCommitment).not.toHaveBeenCalled();
    expect(vault.setGuardianEndpoint).not.toHaveBeenCalled();
  });

  it('rejects without calling verify when the account has no on-chain SDK record', async () => {
    (getMidenClient as jest.Mock).mockResolvedValueOnce({ getAccount: jest.fn(async () => undefined) });
    const vault = makeVault({ publicKey: 'pk' });

    expect(await applyUserGuardianEndpoint(vault as never, 'pk', 'https://mine')).toBe(false);

    expect(getGuardianCommitmentFromAccount).not.toHaveBeenCalled();
    expect(verifyEndpointMatchesCommitment).not.toHaveBeenCalled();
  });
});
