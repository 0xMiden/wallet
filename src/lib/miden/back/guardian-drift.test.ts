import { getGuardianCommitmentFromAccount, resolveChosenGuardianEndpoint } from 'lib/miden/guardian/account';
import {
  checkEndpointCommitment,
  identifyGuardianOperator,
  verifyEndpointMatchesCommitment
} from 'lib/miden/guardian/operator-map';
import { GUARDIAN_URL_STORAGE_KEY } from 'lib/settings/constants';

import {
  SILENT_DRIFT_RUN_STORAGE_KEY,
  SILENT_DRIFT_WINDOWS_BEFORE_PROMPT,
  __resetGuardianDriftProbeCooldownForTest,
  applyUserGuardianEndpoint,
  resolveGuardianDrift,
  revertGuardianEndpointAfterDiscard
} from './guardian-drift';
import { fetchFromStorage, putToStorage } from '../front/storage';
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
  getGuardianCommitmentFromAccount: jest.fn(),
  // The pointer the account CHOSE: its own field, then the legacy global key,
  // never the network default. Shared with the missing-registration self-heal so
  // there is one definition of it. Like the real implementation, this fake lets a
  // failed storage read PROPAGATE — swallowing it would turn "could not find out"
  // into `undefined`, which here is the `'absent'` verdict this module accuses on.
  resolveChosenGuardianEndpoint: jest.fn(async (account: { guardianEndpoint?: string }) => {
    if (account.guardianEndpoint) return account.guardianEndpoint;
    // Required lazily: a `jest.mock` factory is hoisted above the imports.
    const storage = jest.requireActual<typeof import('../front/storage')>('../front/storage');
    const settings = jest.requireActual<typeof import('lib/settings/constants')>('lib/settings/constants');
    return (await storage.fetchFromStorage<string>(settings.GUARDIAN_URL_STORAGE_KEY)) || undefined;
  })
}));

// `identifyGuardianOperator` answers a three-way lookup, because a caller
// weighing it against an endpoint's self-report has to tell "every built-in
// answered and none serves this key" from "the round could not establish that".
const identified = (endpoint: string) => ({ outcome: 'identified', operator: { id: 'gateway', endpoint } });
const noBuiltInServesIt = { outcome: 'none' };
const corroborationUnavailable = { outcome: 'unavailable' };

const makeVault = (acc: Record<string, unknown> | undefined) => {
  const vault = {
    getAccount: jest.fn(async () => acc),
    // Legacy per-field spies, kept so the existing assertions stay expressive;
    // the production port writes through `updateGuardianBinding`, whose default
    // mock fans the patch out to them and reports `applied`. A test that wants
    // the CAS to refuse overrides `updateGuardianBinding` directly.
    setGuardianEndpoint: jest.fn(),
    setGuardianOperatorCommitment: jest.fn(),
    setGuardianSyncStatus: jest.fn(),
    updateGuardianBinding: jest.fn(
      async (
        pk: string,
        _epoch: number,
        patch: { guardianEndpoint?: string; guardianOperatorCommitment?: string }
      ): Promise<{ outcome: 'applied' | 'stale' }> => {
        if (patch.guardianEndpoint !== undefined) await vault.setGuardianEndpoint(pk, patch.guardianEndpoint);
        if (patch.guardianOperatorCommitment !== undefined)
          await vault.setGuardianOperatorCommitment(pk, patch.guardianOperatorCommitment);
        return { outcome: 'applied' };
      }
    )
  };
  return vault;
};

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

beforeEach(async () => {
  jest.clearAllMocks();
  // The operator probes are rate-limited per account by a module-level cooldown,
  // and the silent-drift run is PERSISTED (it has to survive a realm restart), so
  // clearing it is async and has to be awaited or it leaks into the next case.
  await __resetGuardianDriftProbeCooldownForTest();
  // The legacy global guardian pointer lives in real storage in this suite, so a
  // case that seeds it would otherwise hand it to every case that follows.
  await putToStorage(GUARDIAN_URL_STORAGE_KEY, '');
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
  (identifyGuardianOperator as jest.Mock).mockResolvedValue(identified('https://g'));
  const vault = makeVault({ publicKey: 'pk', guardianOperatorCommitment: 'oldC' });

  expect(await resolveGuardianDrift(vault as never, 'pk')).toEqual({ status: 'in-sync', changed: true });

  expect(vault.setGuardianEndpoint).toHaveBeenCalledWith('pk', 'https://g');
  expect(vault.setGuardianOperatorCommitment).toHaveBeenCalledWith('pk', 'newC');
  expect(vault.setGuardianSyncStatus).toHaveBeenLastCalledWith('pk', 'in-sync');
  // No `resolving` on the way: this account stores no endpoint, so nothing has
  // denied anything, and the built-in lookup below can still end in "change
  // nothing" (an incomplete round). A `resolving` written first would then be
  // left behind — a status with no banner and no recovery path.
  expect(vault.setGuardianSyncStatus).not.toHaveBeenCalledWith('pk', 'resolving');
});

it('lands endpoint and baseline as one binding patch BEFORE the status write, so a failed status write self-heals on the next tick', async () => {
  (getGuardianCommitmentFromAccount as jest.Mock).mockReturnValue('newC');
  (identifyGuardianOperator as jest.Mock).mockResolvedValue(identified('https://g'));
  const vault = makeVault({ publicKey: 'pk', guardianOperatorCommitment: 'oldC' });
  const order = trackWriteOrder(vault);

  expect(await resolveGuardianDrift(vault as never, 'pk')).toEqual({ status: 'in-sync', changed: true });

  expect(order).toEqual(['endpoint', 'commitment', 'status:in-sync']);
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
  (identifyGuardianOperator as jest.Mock).mockResolvedValue(identified('https://g'));
  const vault = makeVault({ publicKey: 'pk' });

  expect(await resolveGuardianDrift(vault as never, 'pk')).toEqual({ status: 'in-sync', changed: true });

  expect(vault.setGuardianEndpoint).toHaveBeenCalledWith('pk', 'https://g');
  expect(vault.setGuardianOperatorCommitment).toHaveBeenCalledWith('pk', 'newC');
  expect(vault.setGuardianSyncStatus).toHaveBeenLastCalledWith('pk', 'in-sync');
});

// No stored endpoint AND a COMPLETE round that named no built-in: there is no
// operator this wallet can reach and no duration that would change that, so this
// one is asked immediately rather than waiting out the silent-drift run (which
// exists to tell a briefly-down endpoint from a dead one — there is no endpoint
// here to be down).
it('flags needs-user-input immediately when nothing is stored and no built-in operator matches', async () => {
  (getGuardianCommitmentFromAccount as jest.Mock).mockReturnValue('customC');
  (identifyGuardianOperator as jest.Mock).mockResolvedValue(noBuiltInServesIt);
  const vault = makeVault({ publicKey: 'pk', guardianOperatorCommitment: 'oldC' });

  expect(await resolveGuardianDrift(vault as never, 'pk')).toEqual({ status: 'needs-user-input', changed: true });

  expect(vault.setGuardianSyncStatus).toHaveBeenCalledTimes(1);
  expect(vault.setGuardianSyncStatus).toHaveBeenCalledWith('pk', 'needs-user-input');
  expect(vault.setGuardianEndpoint).not.toHaveBeenCalled();
  expect(vault.setGuardianOperatorCommitment).not.toHaveBeenCalled();
});

// The other half of that rule, and the one a boolean got wrong: an INCOMPLETE
// round establishes nothing about an account with no stored endpoint either, so
// it must not be accused on the strength of our own probes failing. A legacy
// record whose endpoint backfill has not run yet is exactly this shape.
it('says nothing when nothing is stored and the built-in round could not complete', async () => {
  (getGuardianCommitmentFromAccount as jest.Mock).mockReturnValue('customC');
  (identifyGuardianOperator as jest.Mock).mockResolvedValue(corroborationUnavailable);
  const vault = makeVault({ publicKey: 'pk', guardianOperatorCommitment: 'oldC', guardianSyncStatus: 'in-sync' });

  expect(await resolveGuardianDrift(vault as never, 'pk')).toEqual({ status: 'in-sync', changed: false });

  expect(vault.setGuardianSyncStatus).not.toHaveBeenCalled();
  expect(vault.setGuardianEndpoint).not.toHaveBeenCalled();
  expect(vault.setGuardianOperatorCommitment).not.toHaveBeenCalled();
});

it('affirms in-sync when the STORED endpoint matches on-chain and no built-in claims that commitment — a deliberate custom-URL switch must not flag needs-user-input', async () => {
  (getGuardianCommitmentFromAccount as jest.Mock).mockReturnValue('customC');
  (checkEndpointCommitment as jest.Mock).mockResolvedValue('match');
  (identifyGuardianOperator as jest.Mock).mockResolvedValue(noBuiltInServesIt);
  const vault = makeVault({
    publicKey: 'pk',
    guardianOperatorCommitment: 'oldC',
    guardianEndpoint: 'https://custom.guardian'
  });
  const order = trackWriteOrder(vault);

  expect(await resolveGuardianDrift(vault as never, 'pk')).toEqual({ status: 'in-sync', changed: true });

  expect(checkEndpointCommitment).toHaveBeenCalledWith('https://custom.guardian', 'customC');
  // No built-in serves this commitment, so the stored endpoint's self-report is
  // the only evidence there is: a genuine custom operator, same trust level as a
  // URL the user typed into the banner. Endpoint is already correct — only status
  // + baseline are written, commitment LAST (mirroring the other branches).
  expect(identifyGuardianOperator).toHaveBeenCalledWith('customC');
  expect(vault.setGuardianEndpoint).not.toHaveBeenCalled();
  expect(order).toEqual(['commitment', 'status:in-sync']);
});

// `GET /pubkey` is unauthenticated, so a stored endpoint can simply ASSERT the
// account's on-chain commitment. Believing it advanced the baseline, and from
// then on the cheap first branch answered `in-sync` before any probe ran — a
// stale or hostile URL permanently vetoed reconciliation, with a green "Online"
// pill and no `needs-user-input` prompt the user could act on.
it('prefers a built-in operator over a stored endpoint that self-certifies with the same commitment', async () => {
  (getGuardianCommitmentFromAccount as jest.Mock).mockReturnValue('newC');
  (checkEndpointCommitment as jest.Mock).mockResolvedValue('match');
  (identifyGuardianOperator as jest.Mock).mockResolvedValue(identified('https://real.guardian'));
  const vault = makeVault({
    publicKey: 'pk',
    guardianOperatorCommitment: 'oldC',
    guardianEndpoint: 'https://hostile.guardian'
  });
  const order = trackWriteOrder(vault);

  expect(await resolveGuardianDrift(vault as never, 'pk')).toEqual({ status: 'in-sync', changed: true });

  expect(identifyGuardianOperator).toHaveBeenCalledWith('newC');
  expect(vault.setGuardianEndpoint).toHaveBeenCalledWith('pk', 'https://real.guardian');
  expect(vault.setGuardianOperatorCommitment).toHaveBeenCalledWith('pk', 'newC');
  expect(order).toEqual(['endpoint', 'commitment', 'status:in-sync']);
});

// Every built-in probe swallows its own failure, so a round where none of them
// answered used to be indistinguishable from a round that answered "no built-in
// serves this commitment" — and the second one advances the baseline, which
// latches: from then on the cheap first branch answers `in-sync` with no probe at
// all. So a captive network, an offline device, or an attacker who can drop
// traffic to the built-ins was enough to make a stored endpoint's self-report
// permanent, which is the exact state the corroboration exists to prevent.
it('does not advance the baseline when the built-in corroboration could not run', async () => {
  (getGuardianCommitmentFromAccount as jest.Mock).mockReturnValue('newC');
  (checkEndpointCommitment as jest.Mock).mockResolvedValue('match');
  (identifyGuardianOperator as jest.Mock).mockResolvedValue(corroborationUnavailable);
  const vault = makeVault({
    publicKey: 'pk',
    guardianOperatorCommitment: 'oldC',
    guardianEndpoint: 'https://hostile.guardian',
    guardianSyncStatus: 'in-sync'
  });

  expect(await resolveGuardianDrift(vault as never, 'pk')).toEqual({ status: 'in-sync', changed: false });

  // Nothing at all is written: not the baseline that would latch the claim, and
  // not a status either — affirming `in-sync` off an unverified self-report would
  // let a hostile endpoint clear a warning the user has not resolved.
  expect(vault.setGuardianOperatorCommitment).not.toHaveBeenCalled();
  expect(vault.setGuardianSyncStatus).not.toHaveBeenCalled();
  expect(vault.setGuardianEndpoint).not.toHaveBeenCalled();
});

// The withheld baseline must not cost the user an accusation either — but
// "preserve whatever status it had" was the wrong reading of that, and this test
// used to assert it. A BLOCKING status is not neutral: `assertGuardianInSync`
// refuses every transaction while it stands, so preserving it made the account's
// ability to transact depend on the availability of operators it does not use, and
// one unreachable built-in held the freeze open forever. The full reasoning, and
// why unblocking on the endpoint's own word grants nothing the wallet does not
// already grant on that same word, is in `resolveGuardianDrift` and in
// 'exoneration must not depend on operators the account does not use' below.
it('lifts a blocking status when a stored-endpoint match cannot be corroborated', async () => {
  (getGuardianCommitmentFromAccount as jest.Mock).mockReturnValue('newC');
  (checkEndpointCommitment as jest.Mock).mockResolvedValue('match');
  (identifyGuardianOperator as jest.Mock).mockResolvedValue(corroborationUnavailable);
  const vault = makeVault({
    publicKey: 'pk',
    guardianOperatorCommitment: 'oldC',
    guardianEndpoint: 'https://custom.guardian',
    guardianSyncStatus: 'needs-user-input'
  });

  expect(await resolveGuardianDrift(vault as never, 'pk')).toEqual({ status: 'in-sync', changed: true });

  expect(vault.setGuardianSyncStatus).toHaveBeenCalledWith('pk', 'in-sync');
  // The baseline is still withheld, so this is not a latch: the next window
  // re-probes and can re-accuse.
  expect(vault.setGuardianOperatorCommitment).not.toHaveBeenCalled();
});

// Not advancing the baseline is only tolerable because the next probe window
// settles it — and only bounded because that window is a minute wide, not a tick.
it('re-probes an uncorroborated match after the cooldown and settles once the built-ins answer', async () => {
  (getGuardianCommitmentFromAccount as jest.Mock).mockReturnValue('customC');
  (checkEndpointCommitment as jest.Mock).mockResolvedValue('match');
  (identifyGuardianOperator as jest.Mock).mockResolvedValue(corroborationUnavailable);
  const drifted = () =>
    makeVault({
      publicKey: 'pk',
      guardianOperatorCommitment: 'oldC',
      guardianEndpoint: 'https://custom.guardian',
      guardianSyncStatus: 'in-sync'
    });

  await resolveGuardianDrift(drifted() as never, 'pk');
  expect(identifyGuardianOperator).toHaveBeenCalledTimes(1);

  // Inside the window the tick is free: no probe, no fan-out, no write.
  await resolveGuardianDrift(drifted() as never, 'pk');
  expect(checkEndpointCommitment).toHaveBeenCalledTimes(1);
  expect(identifyGuardianOperator).toHaveBeenCalledTimes(1);

  (identifyGuardianOperator as jest.Mock).mockResolvedValue(noBuiltInServesIt);
  const realNow = Date.now;
  Date.now = () => realNow() + 61_000;
  const settled = drifted();
  try {
    expect(await resolveGuardianDrift(settled as never, 'pk')).toEqual({ status: 'in-sync', changed: true });
  } finally {
    Date.now = realNow;
  }
  expect(settled.setGuardianOperatorCommitment).toHaveBeenCalledWith('pk', 'customC');
});

// The built-in's endpoint is a literal in wallet config; the stored one may have
// been typed by a user. Comparing them verbatim would read a trailing slash or a
// difference in host case as a different operator, rewrite the account's endpoint
// to an equivalent URL and report `changed` for a tick that changed nothing.
it('treats a stored endpoint differing from the built-in only in trailing slash and case as the same endpoint', async () => {
  (getGuardianCommitmentFromAccount as jest.Mock).mockReturnValue('newC');
  (checkEndpointCommitment as jest.Mock).mockResolvedValue('match');
  (identifyGuardianOperator as jest.Mock).mockResolvedValue(identified('https://Guardian.Example.com'));
  const vault = makeVault({
    publicKey: 'pk',
    guardianOperatorCommitment: 'oldC',
    guardianEndpoint: 'https://guardian.example.com/'
  });
  const order = trackWriteOrder(vault);

  expect(await resolveGuardianDrift(vault as never, 'pk')).toEqual({ status: 'in-sync', changed: true });

  expect(vault.setGuardianEndpoint).not.toHaveBeenCalled();
  expect(order).toEqual(['commitment', 'status:in-sync']);
});

it('still flags needs-user-input when the stored endpoint does NOT match on-chain (genuine out-of-band switch)', async () => {
  (getGuardianCommitmentFromAccount as jest.Mock).mockReturnValue('customC');
  (identifyGuardianOperator as jest.Mock).mockResolvedValue(noBuiltInServesIt);
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

// An unavailable built-in round withholds the baseline on the `'match'` path, but
// it must NOT soften this one. Here the stored endpoint itself denied holding the
// on-chain key, so the drift is established without the built-ins having answered
// anything — and the account genuinely needs a URL only the user can supply.
it('still flags needs-user-input on a stored-endpoint mismatch when the built-in round could not complete', async () => {
  (getGuardianCommitmentFromAccount as jest.Mock).mockReturnValue('customC');
  (checkEndpointCommitment as jest.Mock).mockResolvedValue('mismatch');
  (identifyGuardianOperator as jest.Mock).mockResolvedValue(corroborationUnavailable);
  const vault = makeVault({
    publicKey: 'pk',
    guardianOperatorCommitment: 'oldC',
    guardianEndpoint: 'https://stale.guardian'
  });

  expect(await resolveGuardianDrift(vault as never, 'pk')).toEqual({ status: 'needs-user-input', changed: true });

  expect(vault.setGuardianSyncStatus).toHaveBeenNthCalledWith(1, 'pk', 'resolving');
  expect(vault.setGuardianSyncStatus).toHaveBeenLastCalledWith('pk', 'needs-user-input');
  expect(vault.setGuardianEndpoint).not.toHaveBeenCalled();
});

// An unanswered probe is not evidence of drift. Writing `needs-user-input` here
// would accuse an endpoint that may be exactly right, and this path re-runs on
// every ~3s sync tick — so a single outage would otherwise sit the user in front
// of a "re-enter your guardian URL" banner for its whole duration.
it('changes nothing when the stored endpoint is silent and no built-in matches', async () => {
  (getGuardianCommitmentFromAccount as jest.Mock).mockReturnValue('customC');
  (checkEndpointCommitment as jest.Mock).mockResolvedValue('unreachable');
  (identifyGuardianOperator as jest.Mock).mockResolvedValue(noBuiltInServesIt);
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
});

// The one state in the whole flow with no other exit: the chain names a CUSTOM
// operator N, the vault names the dead operator O the rotation was fleeing, and
// neither evidence source can say so — O is unreachable by definition on the
// direct path, and the built-in lookup matches built-ins only, so a custom N
// never matches. Withholding the accusation forever (correct on any single
// window) therefore also withheld it from the account that genuinely needs it,
// and the prompt is what reaches `applyUserGuardianEndpoint`, the verified
// repair. Duration is the only thing that separates the two.
describe('a sustained silent drift eventually asks the user, but a blip never does', () => {
  const strandedVault = () =>
    makeVault({
      publicKey: 'pk',
      guardianOperatorCommitment: 'oldC',
      guardianEndpoint: 'https://dead.guardian',
      guardianSyncStatus: 'in-sync'
    });

  // The clock is monotonic ACROSS calls, not per call: each window has to land
  // past the cooldown the previous one set, or the probe is skipped and the
  // window never happens — which would make every assertion below pass for the
  // wrong reason.
  let elapsedWindows = 0;

  /** One window short of the accusation — the longest run that must stay quiet. */
  const justUnder = SILENT_DRIFT_WINDOWS_BEFORE_PROMPT - 1;

  /** Run `count` probe WINDOWS, stepping past the cooldown between each. */
  const runWindows = async (count: number, vault: () => ReturnType<typeof makeVault>) => {
    const realNow = Date.now;
    const base = realNow();
    let last: { status: string; changed: boolean } = { status: 'in-sync', changed: false };
    try {
      for (let window = 0; window < count; window++) {
        const at = base + elapsedWindows++ * 61_000;
        Date.now = () => at;
        last = await resolveGuardianDrift(vault() as never, 'pk');
      }
    } finally {
      Date.now = realNow;
    }
    return last;
  };

  beforeEach(() => {
    elapsedWindows = 0;
    (getGuardianCommitmentFromAccount as jest.Mock).mockReturnValue('customC');
    (checkEndpointCommitment as jest.Mock).mockResolvedValue('unreachable');
    (identifyGuardianOperator as jest.Mock).mockResolvedValue(noBuiltInServesIt);
  });

  it('says nothing for a long run of windows short of the threshold', async () => {
    const vault = strandedVault();
    expect(await runWindows(justUnder, () => vault)).toEqual({ status: 'in-sync', changed: false });
    expect(vault.setGuardianSyncStatus).not.toHaveBeenCalled();
  });

  it('asks the user once the silence has survived the full run', async () => {
    const vault = strandedVault();
    expect(await runWindows(SILENT_DRIFT_WINDOWS_BEFORE_PROMPT, () => vault)).toEqual({
      status: 'needs-user-input',
      changed: true
    });
    expect(vault.setGuardianSyncStatus).toHaveBeenCalledTimes(1);
    expect(vault.setGuardianSyncStatus).toHaveBeenCalledWith('pk', 'needs-user-input');
  });

  // The status write is what broadcasts fresh account state to the popup. Once
  // flagged, repeating it every window would do that once a minute for as long
  // as the account stays stranded, and nothing about the account has changed.
  it('does not re-write the flag on every window once it is set', async () => {
    const flagged = makeVault({
      publicKey: 'pk',
      guardianOperatorCommitment: 'oldC',
      guardianEndpoint: 'https://dead.guardian',
      guardianSyncStatus: 'needs-user-input'
    });

    expect(await runWindows(SILENT_DRIFT_WINDOWS_BEFORE_PROMPT + 10, () => flagged)).toEqual({
      status: 'needs-user-input',
      changed: false
    });
    expect(flagged.setGuardianSyncStatus).not.toHaveBeenCalled();
  });

  // An offline device, a captive network or an attacker suppressing one operator
  // all report `'unavailable'`, and none of them says anything about why THIS
  // endpoint is silent. Counting wall-clock instead of informative windows would
  // let any of them buy the accusation by simply lasting long enough.
  it('never accuses on windows where the built-in round could not complete', async () => {
    (identifyGuardianOperator as jest.Mock).mockResolvedValue(corroborationUnavailable);
    const vault = strandedVault();

    expect(await runWindows(SILENT_DRIFT_WINDOWS_BEFORE_PROMPT * 4, () => vault)).toEqual({
      status: 'in-sync',
      changed: false
    });
    expect(vault.setGuardianSyncStatus).not.toHaveBeenCalled();
  });

  // The run has to be UNBROKEN. A device that drops off the network for a while
  // mid-outage must not have those windows count toward a verdict about the
  // endpoint.
  it('restarts the run when a window comes back uninformative', async () => {
    const vault = strandedVault();
    await runWindows(justUnder, () => vault);

    (identifyGuardianOperator as jest.Mock).mockResolvedValue(corroborationUnavailable);
    await runWindows(1, () => vault);
    (identifyGuardianOperator as jest.Mock).mockResolvedValue(noBuiltInServesIt);

    // Were the count merely paused rather than reset, this single window would
    // reach the threshold and accuse.
    expect(await runWindows(1, () => vault)).toEqual({ status: 'in-sync', changed: false });
    expect(vault.setGuardianSyncStatus).not.toHaveBeenCalled();
  });

  // The whole point of persisting the run. `syncGuardianAccounts` has exactly one
  // driver (`useSyncTrigger`, a React hook), so on the extension windows advance
  // only while the popup is open and the drift state lives in the worker the popup
  // keeps alive. Five minutes of CONTINUOUSLY open popup is not a plausible
  // session, so an in-memory run made this prompt — the only exit for a stranded
  // custom operator — unreachable on that platform.
  describe('the run survives the realm that accumulated it', () => {
    /** Drop the module's memory, keep storage: what a popup close / worker recycle does. */
    const realmRestart = async () => {
      const runs = await fetchFromStorage<unknown>(SILENT_DRIFT_RUN_STORAGE_KEY);
      await __resetGuardianDriftProbeCooldownForTest();
      await putToStorage(SILENT_DRIFT_RUN_STORAGE_KEY, runs);
    };

    it('reaches the prompt across several short sessions', async () => {
      const vault = strandedVault();
      for (let session = 0; session < justUnder; session++) {
        await runWindows(1, () => vault);
        await realmRestart();
      }
      expect(vault.setGuardianSyncStatus).not.toHaveBeenCalled();

      // The window that completes the run lands in yet another fresh realm.
      expect(await runWindows(1, () => vault)).toEqual({ status: 'needs-user-input', changed: true });
    });

    it('does not let realm churn buy the accusation faster than the cooldown', async () => {
      // Same instant throughout: the in-memory cooldown is gone after each
      // restart, so only the run's own record of when it last counted a window
      // stands between a popup opened five times in ten seconds and an accusation.
      const vault = strandedVault();
      const realNow = Date.now;
      const at = realNow();
      Date.now = () => at;
      try {
        for (let session = 0; session < SILENT_DRIFT_WINDOWS_BEFORE_PROMPT + 3; session++) {
          await resolveGuardianDrift(vault as never, 'pk');
          await realmRestart();
        }
      } finally {
        Date.now = realNow;
      }

      expect(vault.setGuardianSyncStatus).not.toHaveBeenCalled();
    });

    it('restarts rather than accumulating across a gap longer than the run allows', async () => {
      const vault = strandedVault();
      for (let session = 0; session < justUnder; session++) {
        await runWindows(1, () => vault);
        await realmRestart();
      }

      // A device that is offline half the time observed nothing during the gap, so
      // the endpoint may well have been answering throughout it.
      const realNow = Date.now;
      const at = realNow() + 60 * 60_000;
      Date.now = () => at;
      try {
        expect(await resolveGuardianDrift(vault as never, 'pk')).toEqual({ status: 'in-sync', changed: false });
      } finally {
        Date.now = realNow;
      }
      expect(vault.setGuardianSyncStatus).not.toHaveBeenCalled();
    });
  });

  // The run's subject is the pair (account, STORED endpoint) — "this endpoint has
  // been dark for N windows" — while the map is keyed by account alone. A run
  // handed to a different endpoint accuses it on its first window, which is
  // exactly the blip this rule exists to absorb. Reachable: a rotation whose
  // endpoint write fails leaves the account drifted with a dead operator stored
  // and accumulating windows, and rotating again then spends them on the new one,
  // whose first window is plausibly silent while a self-hosted operator starts.
  it('does not spend windows earned by one stored endpoint on the next one', async () => {
    const dead = strandedVault();
    await runWindows(justUnder, () => dead);
    expect(dead.setGuardianSyncStatus).not.toHaveBeenCalled();

    // Second rotation lands the endpoint write. Still drifted — nothing advances
    // the commitment baseline — and the new operator is silent on its first window.
    const rotated = makeVault({
      publicKey: 'pk',
      guardianOperatorCommitment: 'oldC',
      guardianEndpoint: 'https://fresh.guardian',
      guardianSyncStatus: 'in-sync'
    });

    expect(await runWindows(1, () => rotated)).toEqual({ status: 'in-sync', changed: false });
    expect(rotated.setGuardianSyncStatus).not.toHaveBeenCalled();

    // And the new endpoint earns its own full run rather than being let off: the
    // reset re-arms the guard, it does not disable it.
    expect(await runWindows(justUnder, () => rotated)).toEqual({
      status: 'needs-user-input',
      changed: true
    });
  });

  // The cooldown is the milder half of the same key: it means "we probed this
  // account's operators recently", so after a rotation it left the NEW endpoint
  // unprobed — and the account on a stale status — for up to a full period.
  it('probes a newly stored endpoint immediately rather than serving out the old cooldown', async () => {
    const dead = strandedVault();
    await runWindows(1, () => dead);
    (checkEndpointCommitment as jest.Mock).mockClear();

    const rotated = makeVault({
      publicKey: 'pk',
      guardianOperatorCommitment: 'oldC',
      guardianEndpoint: 'https://fresh.guardian',
      guardianSyncStatus: 'in-sync'
    });
    // Same instant as the window just run, so only the endpoint change — never
    // the clock — can allow this probe.
    const realNow = Date.now;
    const at = realNow();
    Date.now = () => at;
    try {
      await resolveGuardianDrift(rotated as never, 'pk');
    } finally {
      Date.now = realNow;
    }

    expect(checkEndpointCommitment).toHaveBeenCalledWith('https://fresh.guardian', 'customC');
  });

  // The false-positive cost has to stay bounded: the moment the endpoint speaks
  // again the account resolves itself and the banner goes away untouched.
  it('self-clears when the briefly-down endpoint comes back and matches', async () => {
    const vault = strandedVault();
    await runWindows(justUnder, () => vault);

    (checkEndpointCommitment as jest.Mock).mockResolvedValue('match');
    const recovered = makeVault({
      publicKey: 'pk',
      guardianOperatorCommitment: 'oldC',
      guardianEndpoint: 'https://dead.guardian',
      guardianSyncStatus: 'in-sync'
    });

    expect(await runWindows(1, () => recovered)).toEqual({ status: 'in-sync', changed: true });
    expect(recovered.setGuardianOperatorCommitment).toHaveBeenCalledWith('pk', 'customC');
  });

  // The run tracks SILENCE, so an endpoint that answers ends it — even when the
  // answer is a denial, which accuses on its own and never consults the run.
  // `applyUserGuardianEndpoint` repairs an account without going through this
  // function, so a run left behind here would be inherited by the account's next
  // drift and shorten the wait for an accusation it did not earn.
  it('drops the silent run once the stored endpoint answers at all', async () => {
    const vault = strandedVault();
    await runWindows(justUnder, () => vault);

    // A denial: the endpoint answered and does not hold the on-chain key.
    (checkEndpointCommitment as jest.Mock).mockResolvedValue('mismatch');
    const denied = strandedVault();
    expect(await runWindows(1, () => denied)).toEqual({ status: 'needs-user-input', changed: true });

    // Back to silence with the run cleared: a single window must not accuse.
    (checkEndpointCommitment as jest.Mock).mockResolvedValue('unreachable');
    const silentAgain = strandedVault();
    expect(await runWindows(1, () => silentAgain)).toEqual({ status: 'in-sync', changed: false });
    expect(silentAgain.setGuardianSyncStatus).not.toHaveBeenCalled();
  });

  // A resolved account must not carry its old run into the next drift.
  it('forgets the run once the account is back in sync', async () => {
    const vault = strandedVault();
    await runWindows(justUnder, () => vault);

    const inSync = makeVault({ publicKey: 'pk', guardianOperatorCommitment: 'customC', guardianSyncStatus: 'in-sync' });
    await resolveGuardianDrift(inSync as never, 'pk');

    const again = strandedVault();
    expect(await runWindows(1, () => again)).toEqual({ status: 'in-sync', changed: false });
    expect(again.setGuardianSyncStatus).not.toHaveBeenCalled();
  });
});

// The state that made this the difference between recoverable and not: a
// rotation whose `update_guardian` COMMITTED but whose endpoint write did not
// (`endpointPersistFailed`). The vault still names the previous operator, and on
// the direct-switch path that operator is unreachable by definition — so the
// stored-endpoint probe answers `unreachable` on every tick, forever. Returning
// there meant this reconciler, the documented repair for exactly that state,
// never asked the one question that could resolve it.
it('names the on-chain operator even when the stored endpoint is silent', async () => {
  (getGuardianCommitmentFromAccount as jest.Mock).mockReturnValue('newC');
  (checkEndpointCommitment as jest.Mock).mockResolvedValue('unreachable');
  (identifyGuardianOperator as jest.Mock).mockResolvedValue(identified('https://new.guardian'));
  const vault = makeVault({
    publicKey: 'pk',
    guardianOperatorCommitment: 'oldC',
    guardianEndpoint: 'https://dead.guardian',
    guardianSyncStatus: 'in-sync'
  });

  expect(await resolveGuardianDrift(vault as never, 'pk')).toEqual({ status: 'in-sync', changed: true });

  // A built-in that serves the on-chain commitment is positive evidence, not an
  // inference from silence — so acting on it is safe where accusing is not.
  expect(identifyGuardianOperator).toHaveBeenCalledWith('newC');
  expect(vault.setGuardianEndpoint).toHaveBeenCalledWith('pk', 'https://new.guardian');
  expect(vault.setGuardianOperatorCommitment).toHaveBeenCalledWith('pk', 'newC');
  expect(vault.setGuardianSyncStatus).toHaveBeenLastCalledWith('pk', 'in-sync');
  // And never the `resolving` marker on the way, since the stored endpoint never
  // answered.
  expect(vault.setGuardianSyncStatus).not.toHaveBeenCalledWith('pk', 'resolving');
});

it('preserves an already-flagged status when the stored endpoint cannot be reached', async () => {
  (getGuardianCommitmentFromAccount as jest.Mock).mockReturnValue('customC');
  (checkEndpointCommitment as jest.Mock).mockResolvedValue('unreachable');
  (identifyGuardianOperator as jest.Mock).mockResolvedValue(noBuiltInServesIt);
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

// The probing half of this function is reached exactly when the account is NOT
// in sync — a state that persists until it is resolved — and the caller ticks
// every ~3s. Unthrottled, a `needs-user-input` account fans out to every
// built-in operator indefinitely, with a 5s per-probe deadline that makes the
// requests overlap rather than queue.
describe('operator-probe cooldown', () => {
  const driftedVault = () =>
    makeVault({
      publicKey: 'pk',
      guardianOperatorCommitment: 'oldC',
      guardianEndpoint: 'https://custom.guardian',
      guardianSyncStatus: 'needs-user-input'
    });

  beforeEach(() => {
    (getGuardianCommitmentFromAccount as jest.Mock).mockReturnValue('customC');
    (checkEndpointCommitment as jest.Mock).mockResolvedValue('mismatch');
    (identifyGuardianOperator as jest.Mock).mockResolvedValue(noBuiltInServesIt);
  });

  it('probes once and then reports the stored status without re-probing', async () => {
    expect(await resolveGuardianDrift(driftedVault() as never, 'pk')).toEqual({
      status: 'needs-user-input',
      changed: true
    });
    expect(checkEndpointCommitment).toHaveBeenCalledTimes(1);
    expect(identifyGuardianOperator).toHaveBeenCalledTimes(1);

    for (let tick = 0; tick < 5; tick++) {
      expect(await resolveGuardianDrift(driftedVault() as never, 'pk')).toEqual({
        status: 'needs-user-input',
        changed: false
      });
    }
    expect(checkEndpointCommitment).toHaveBeenCalledTimes(1);
    expect(identifyGuardianOperator).toHaveBeenCalledTimes(1);
  });

  it('probes again once the cooldown lapses', async () => {
    await resolveGuardianDrift(driftedVault() as never, 'pk');
    expect(checkEndpointCommitment).toHaveBeenCalledTimes(1);

    const realNow = Date.now;
    Date.now = () => realNow() + 61_000;
    try {
      await resolveGuardianDrift(driftedVault() as never, 'pk');
    } finally {
      Date.now = realNow;
    }
    expect(checkEndpointCommitment).toHaveBeenCalledTimes(2);
  });

  it('does not throttle the local baseline comparison, and clears the cooldown when the account is back in sync', async () => {
    await resolveGuardianDrift(driftedVault() as never, 'pk');

    // Baseline now matches on chain: the cheap path answers on every tick.
    const inSync = makeVault({ publicKey: 'pk', guardianOperatorCommitment: 'customC', guardianSyncStatus: 'in-sync' });
    expect(await resolveGuardianDrift(inSync as never, 'pk')).toEqual({ status: 'in-sync', changed: false });

    // …and a genuinely NEW drift is probed immediately rather than inheriting
    // the previous drift's cooldown.
    await resolveGuardianDrift(driftedVault() as never, 'pk');
    expect(checkEndpointCommitment).toHaveBeenCalledTimes(2);
  });

  // Corroborating a stored-endpoint `'match'` is a second fan-out over every
  // built-in, on a path that used to return after a single probe — so it has to
  // sit behind the same gate, or an account whose baseline never advances turns
  // the ~3s tick into a fan-out per tick.
  it('gates the corroboration fan-out on a stored-endpoint match behind the cooldown', async () => {
    await resolveGuardianDrift(driftedVault() as never, 'pk');
    expect(checkEndpointCommitment).toHaveBeenCalledTimes(1);
    expect(identifyGuardianOperator).toHaveBeenCalledTimes(1);

    (checkEndpointCommitment as jest.Mock).mockResolvedValue('match');
    expect(await resolveGuardianDrift(driftedVault() as never, 'pk')).toEqual({
      status: 'needs-user-input',
      changed: false
    });

    expect(checkEndpointCommitment).toHaveBeenCalledTimes(1);
    expect(identifyGuardianOperator).toHaveBeenCalledTimes(1);
  });

  it('cools down per account, so one stuck account does not silence another', async () => {
    await resolveGuardianDrift(driftedVault() as never, 'pk');
    await resolveGuardianDrift(driftedVault() as never, 'other-pk');

    expect(checkEndpointCommitment).toHaveBeenCalledTimes(2);
  });
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
    (verifyEndpointMatchesCommitment as jest.Mock).mockResolvedValue('match');
    const vault = makeVault({ publicKey: 'pk', guardianOperatorCommitment: 'old' });

    expect(await applyUserGuardianEndpoint(vault as never, 'pk', 'https://mine')).toBe('applied');

    expect(verifyEndpointMatchesCommitment).toHaveBeenCalledWith('https://mine', 'cc');
    expect(vault.setGuardianEndpoint).toHaveBeenCalledWith('pk', 'https://mine');
    expect(vault.setGuardianOperatorCommitment).toHaveBeenCalledWith('pk', 'cc');
    expect(vault.setGuardianSyncStatus).toHaveBeenLastCalledWith('pk', 'in-sync');
  });

  it('lands endpoint and baseline as one binding patch BEFORE the status write, matching resolveGuardianDrift', async () => {
    (getGuardianCommitmentFromAccount as jest.Mock).mockReturnValue('cc');
    (verifyEndpointMatchesCommitment as jest.Mock).mockResolvedValue('match');
    const vault = makeVault({ publicKey: 'pk', guardianOperatorCommitment: 'old' });
    const order = trackWriteOrder(vault);

    expect(await applyUserGuardianEndpoint(vault as never, 'pk', 'https://mine')).toBe('applied');

    expect(order).toEqual(['endpoint', 'commitment', 'status:in-sync']);
  });

  // The binding is the load-bearing write; the status stamp is advisory and the
  // next drift tick repairs it. Reporting failure after the binding landed sent
  // the banner's generic catch at a user whose apply had succeeded — and whose
  // retry could only ever be 'stale', because this write already bumped the epoch.
  it("still reports 'applied' when the advisory status stamp fails after the binding landed", async () => {
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    (getGuardianCommitmentFromAccount as jest.Mock).mockReturnValue('cc');
    (verifyEndpointMatchesCommitment as jest.Mock).mockResolvedValue('match');
    const vault = makeVault({ publicKey: 'pk', guardianOperatorCommitment: 'old' });
    vault.setGuardianSyncStatus.mockRejectedValueOnce(new Error('storage went away'));

    expect(await applyUserGuardianEndpoint(vault as never, 'pk', 'https://mine')).toBe('applied');

    expect(vault.updateGuardianBinding).toHaveBeenCalled();
  });

  // The vault record is gone or moved under the apply — a statement about the
  // WALLET, not about the chain, which this path has established nothing about.
  it("reports 'stale' rather than 'no-onchain-guardian' when the account is not in the vault", async () => {
    const vault = makeVault(undefined);

    expect(await applyUserGuardianEndpoint(vault as never, 'pk', 'https://mine')).toBe('stale');

    expect(verifyEndpointMatchesCommitment).not.toHaveBeenCalled();
  });

  it('rejects a user URL that does not match on-chain', async () => {
    (getGuardianCommitmentFromAccount as jest.Mock).mockReturnValue('cc');
    (verifyEndpointMatchesCommitment as jest.Mock).mockResolvedValue('mismatch');
    const vault = makeVault({ publicKey: 'pk' });

    expect(await applyUserGuardianEndpoint(vault as never, 'pk', 'https://wrong')).toBe('mismatch');

    expect(vault.setGuardianEndpoint).not.toHaveBeenCalled();
    expect(vault.setGuardianOperatorCommitment).not.toHaveBeenCalled();
    expect(vault.setGuardianSyncStatus).not.toHaveBeenCalled();
  });

  // The whole point of the tri-state: an operator that did not answer is not an
  // operator that answered WRONG, and only the second justifies telling the user
  // their URL is not their guardian. Without this case, collapsing the verdict
  // back to `'mismatch'` here passed every suite — the banner's own tests mock
  // this action wholesale, so they cannot see a backend collapse, and the tests
  // one layer down only pin `verifyEndpointMatchesCommitment` itself.
  it('reports unreachable as unreachable rather than collapsing it into mismatch', async () => {
    (getGuardianCommitmentFromAccount as jest.Mock).mockReturnValue('cc');
    (verifyEndpointMatchesCommitment as jest.Mock).mockResolvedValue('unreachable');
    const vault = makeVault({ publicKey: 'pk' });

    expect(await applyUserGuardianEndpoint(vault as never, 'pk', 'https://cold-start')).toBe('unreachable');

    // Unreachable is still not a licence to WRITE: nothing was confirmed.
    expect(vault.setGuardianEndpoint).not.toHaveBeenCalled();
    expect(vault.setGuardianOperatorCommitment).not.toHaveBeenCalled();
    expect(vault.setGuardianSyncStatus).not.toHaveBeenCalled();
  });

  it('rejects without calling verify when the account has no on-chain guardian commitment', async () => {
    (getGuardianCommitmentFromAccount as jest.Mock).mockReturnValue(undefined);
    const vault = makeVault({ publicKey: 'pk' });

    expect(await applyUserGuardianEndpoint(vault as never, 'pk', 'https://mine')).toBe('no-onchain-guardian');

    expect(verifyEndpointMatchesCommitment).not.toHaveBeenCalled();
    expect(vault.setGuardianEndpoint).not.toHaveBeenCalled();
  });

  it('rejects without calling verify when the account has no on-chain SDK record', async () => {
    (getMidenClient as jest.Mock).mockResolvedValueOnce({ getAccount: jest.fn(async () => undefined) });
    const vault = makeVault({ publicKey: 'pk' });

    expect(await applyUserGuardianEndpoint(vault as never, 'pk', 'https://mine')).toBe('no-onchain-guardian');

    expect(getGuardianCommitmentFromAccount).not.toHaveBeenCalled();
    expect(verifyEndpointMatchesCommitment).not.toHaveBeenCalled();
  });
});

describe('exoneration must not depend on operators the account does not use', () => {
  // Requiring a COMPLETE built-in round to ACCUSE is right. Requiring one to
  // EXONERATE froze the account: `assertGuardianInSync` refuses every send /
  // consume / swap while the status is `needs-user-input`, so one unreachable
  // built-in — any of them, not this account's — held the block open window after
  // window while the account's own operator answered `'match'` on every one and
  // the sync loop succeeded against it. The user saw a non-dismissable "enter your
  // guardian URL" banner asserting something false; an attacker who can drop
  // traffic to a single built-in could hold it there indefinitely.
  it('clears a blocking status on the endpoint own word when corroboration cannot run', async () => {
    (getGuardianCommitmentFromAccount as jest.Mock).mockReturnValue('newC');
    (checkEndpointCommitment as jest.Mock).mockResolvedValue('match');
    (identifyGuardianOperator as jest.Mock).mockResolvedValue(corroborationUnavailable);
    const vault = makeVault({
      publicKey: 'pk',
      guardianEndpoint: 'https://custom.example',
      guardianOperatorCommitment: 'oldC',
      guardianSyncStatus: 'needs-user-input'
    });

    expect(await resolveGuardianDrift(vault as never, 'pk')).toEqual({ status: 'in-sync', changed: true });

    expect(vault.setGuardianSyncStatus).toHaveBeenCalledWith('pk', 'in-sync');
    // But the BASELINE stays unwritten, which is what the corroboration rule
    // actually protects: advancing it on an unaided self-report latches the
    // assertion permanently, because the next tick short-circuits on it before any
    // probe runs. Leaving it unset means every later window re-probes and can
    // re-accuse the moment this endpoint stops matching.
    expect(vault.setGuardianOperatorCommitment).not.toHaveBeenCalled();
  });

  it('does not re-write the status once it is already in-sync', async () => {
    (getGuardianCommitmentFromAccount as jest.Mock).mockReturnValue('newC');
    (checkEndpointCommitment as jest.Mock).mockResolvedValue('match');
    (identifyGuardianOperator as jest.Mock).mockResolvedValue(corroborationUnavailable);
    const vault = makeVault({
      publicKey: 'pk',
      guardianEndpoint: 'https://custom.example',
      guardianOperatorCommitment: 'oldC',
      guardianSyncStatus: 'in-sync'
    });

    expect(await resolveGuardianDrift(vault as never, 'pk')).toEqual({ status: 'in-sync', changed: false });
    expect(vault.setGuardianSyncStatus).not.toHaveBeenCalled();
  });
});

// The rollback the pending-rotation recheck runs when the node discards a
// guardian switch. Its evidence — the row's `previousGuardianEndpoint` — was
// stamped when the rotation was initiated and can be half an hour old by the
// time this fires, so every case here is about it refusing to win against newer
// state, and about not writing on evidence it could not read.
describe('revertGuardianEndpointAfterDiscard', () => {
  const boundTo = (endpoint: string, epoch?: number) =>
    makeVault({
      publicKey: 'pk',
      guardianEndpoint: endpoint,
      ...(epoch === undefined ? {} : { guardianEpoch: epoch })
    });

  it('rolls the binding back when the chain says the bound endpoint has no authority', async () => {
    (getMidenClient as jest.Mock).mockResolvedValue({ getAccount: async () => ({}) });
    (getGuardianCommitmentFromAccount as jest.Mock).mockReturnValue('cc');
    (verifyEndpointMatchesCommitment as jest.Mock).mockResolvedValue('mismatch');
    const vault = boundTo('https://new', 4);

    expect(await revertGuardianEndpointAfterDiscard(vault as never, 'pk', 'https://new', 'https://old')).toBe(
      'reverted'
    );

    expect(vault.updateGuardianBinding).toHaveBeenCalledWith('pk', 4, { guardianEndpoint: 'https://old' });
  });

  // THE CASE A URL COMPARISON CANNOT SEE. The user's switch appeared not to
  // work, so they rotated to the same operator again and THAT one committed.
  // The binding still equals `discardedEndpoint` and the epoch has already
  // moved, so only the chain can say the account is correctly bound.
  it('supersedes when the bound endpoint does answer for the on-chain commitment', async () => {
    (getMidenClient as jest.Mock).mockResolvedValue({ getAccount: async () => ({}) });
    (getGuardianCommitmentFromAccount as jest.Mock).mockReturnValue('cc');
    (verifyEndpointMatchesCommitment as jest.Mock).mockResolvedValue('match');
    const vault = boundTo('https://new', 4);

    expect(await revertGuardianEndpointAfterDiscard(vault as never, 'pk', 'https://new', 'https://old')).toBe(
      'superseded'
    );

    expect(vault.updateGuardianBinding).not.toHaveBeenCalled();
  });

  // A second rotation landed while this one was being rechecked. Rolling back to
  // a value from before BOTH would undo a commit that succeeded.
  it('supersedes without writing when the account already names something else', async () => {
    const vault = boundTo('https://newer');

    expect(await revertGuardianEndpointAfterDiscard(vault as never, 'pk', 'https://new', 'https://old')).toBe(
      'superseded'
    );

    expect(vault.updateGuardianBinding).not.toHaveBeenCalled();
    expect(verifyEndpointMatchesCommitment).not.toHaveBeenCalled();
  });

  it('supersedes when the account is gone', async () => {
    const vault = makeVault(undefined);

    expect(await revertGuardianEndpointAfterDiscard(vault as never, 'pk', 'https://new', 'https://old')).toBe(
      'superseded'
    );

    expect(vault.updateGuardianBinding).not.toHaveBeenCalled();
  });

  // Drift canonicalizes spellings, so the row's original URL and the stored one
  // can be the same operator written two ways. A literal `!==` refused the
  // rollback for an account that needed it.
  it('matches the discarded target across trailing-slash and host-case spellings', async () => {
    (getMidenClient as jest.Mock).mockResolvedValue({ getAccount: async () => ({}) });
    (getGuardianCommitmentFromAccount as jest.Mock).mockReturnValue('cc');
    (verifyEndpointMatchesCommitment as jest.Mock).mockResolvedValue('mismatch');
    const vault = boundTo('https://New.Example.com/', 2);

    expect(
      await revertGuardianEndpointAfterDiscard(vault as never, 'pk', 'https://new.example.com', 'https://old')
    ).toBe('reverted');

    expect(vault.updateGuardianBinding).toHaveBeenCalledWith('pk', 2, { guardianEndpoint: 'https://old' });
  });

  // Fail-closed: not looking is never grounds to write. Both of these leave the
  // row pending so a later pass with a warm client can decide on real evidence.
  it("reports 'stale' when the account has no on-chain guardian to check against", async () => {
    (getMidenClient as jest.Mock).mockResolvedValue({ getAccount: async () => undefined });
    const vault = boundTo('https://new', 4);

    expect(await revertGuardianEndpointAfterDiscard(vault as never, 'pk', 'https://new', 'https://old')).toBe('stale');

    expect(vault.updateGuardianBinding).not.toHaveBeenCalled();
  });

  it("reports 'stale' when the operator could not be reached to prove the mismatch", async () => {
    (getMidenClient as jest.Mock).mockResolvedValue({ getAccount: async () => ({}) });
    (getGuardianCommitmentFromAccount as jest.Mock).mockReturnValue('cc');
    (verifyEndpointMatchesCommitment as jest.Mock).mockResolvedValue('unreachable');
    const vault = boundTo('https://new', 4);

    expect(await revertGuardianEndpointAfterDiscard(vault as never, 'pk', 'https://new', 'https://old')).toBe('stale');

    expect(vault.updateGuardianBinding).not.toHaveBeenCalled();
  });

  // The endpoint check and the CAS answer different questions: the first that
  // the rollback is still about the current target, the second that nothing
  // wrote between the read and the write. Only the CAS catches the latter.
  it("reports 'stale' when the epoch moved between the read and the write", async () => {
    (getMidenClient as jest.Mock).mockResolvedValue({ getAccount: async () => ({}) });
    (getGuardianCommitmentFromAccount as jest.Mock).mockReturnValue('cc');
    (verifyEndpointMatchesCommitment as jest.Mock).mockResolvedValue('mismatch');
    const vault = boundTo('https://new', 4);
    vault.updateGuardianBinding.mockResolvedValueOnce({ outcome: 'stale' });

    expect(await revertGuardianEndpointAfterDiscard(vault as never, 'pk', 'https://new', 'https://old')).toBe('stale');
  });

  // An account that never carried an epoch reads as 0, the same baseline a fresh
  // binding CAS expects — not a reason to skip the write.
  it('treats a missing epoch as 0 rather than refusing the rollback', async () => {
    (getMidenClient as jest.Mock).mockResolvedValue({ getAccount: async () => ({}) });
    (getGuardianCommitmentFromAccount as jest.Mock).mockReturnValue('cc');
    (verifyEndpointMatchesCommitment as jest.Mock).mockResolvedValue('mismatch');
    const vault = boundTo('https://new');

    await revertGuardianEndpointAfterDiscard(vault as never, 'pk', 'https://new', 'https://old');

    expect(vault.updateGuardianBinding).toHaveBeenCalledWith('pk', 0, { guardianEndpoint: 'https://old' });
  });
});

describe('the endpoint the account is actually bound to', () => {
  // `resolveGuardianEndpoint` — what the sync loop builds its service from — falls
  // back to the legacy global key, retained by design as the ONLY pointer a
  // pre-per-account-endpoint account on a custom operator has (the unlock backfill
  // deliberately leaves that account's field empty rather than stamping a guess).
  // Reading the raw field here classified that account `'absent'`, which accuses on
  // the FIRST complete round with no duration rule — so an account whose own
  // operator was answering, and whose sync was succeeding on the same tick, got a
  // permanent `needs-user-input` and had every transaction blocked. F-150 fixed
  // this same field-versus-identity confusion in the sync loop.
  it('probes the legacy global pointer rather than accusing an account whose field is empty', async () => {
    await putToStorage(GUARDIAN_URL_STORAGE_KEY, 'https://legacy-custom.example');
    (getGuardianCommitmentFromAccount as jest.Mock).mockReturnValue('newC');
    (checkEndpointCommitment as jest.Mock).mockResolvedValue('match');
    // A complete round: the built-ins all answered and none serves this key, which
    // is exactly what a genuine custom operator looks like.
    (identifyGuardianOperator as jest.Mock).mockResolvedValue(noBuiltInServesIt);
    const vault = makeVault({ publicKey: 'pk', guardianOperatorCommitment: 'oldC' });

    expect(await resolveGuardianDrift(vault as never, 'pk')).toEqual({ status: 'in-sync', changed: true });

    expect(checkEndpointCommitment).toHaveBeenCalledWith('https://legacy-custom.example', 'newC');
    expect(vault.setGuardianSyncStatus).not.toHaveBeenCalledWith('pk', 'needs-user-input');
    expect(vault.setGuardianSyncStatus).toHaveBeenLastCalledWith('pk', 'in-sync');
  });

  // The per-account field still wins when it is set — the fallback is a fallback.
  it('prefers the per-account endpoint over the legacy pointer', async () => {
    await putToStorage(GUARDIAN_URL_STORAGE_KEY, 'https://legacy-custom.example');
    (getGuardianCommitmentFromAccount as jest.Mock).mockReturnValue('newC');
    (checkEndpointCommitment as jest.Mock).mockResolvedValue('match');
    (identifyGuardianOperator as jest.Mock).mockResolvedValue(noBuiltInServesIt);
    const vault = makeVault({
      publicKey: 'pk',
      guardianEndpoint: 'https://per-account.example',
      guardianOperatorCommitment: 'oldC'
    });

    await resolveGuardianDrift(vault as never, 'pk');

    expect(checkEndpointCommitment).toHaveBeenCalledWith('https://per-account.example', 'newC');
  });

  // With no pointer anywhere, `'absent'` still means what it says, and the
  // accuse-on-one-complete-round rule is unchanged.
  it('still accuses an account with no pointer at all', async () => {
    (getGuardianCommitmentFromAccount as jest.Mock).mockReturnValue('newC');
    (identifyGuardianOperator as jest.Mock).mockResolvedValue(noBuiltInServesIt);
    const vault = makeVault({ publicKey: 'pk', guardianOperatorCommitment: 'oldC' });

    expect(await resolveGuardianDrift(vault as never, 'pk')).toEqual({ status: 'needs-user-input', changed: true });
    expect(checkEndpointCommitment).not.toHaveBeenCalled();
  });

  // "Named no operator" and "we could not read which operator" collapse to the
  // same `undefined` at the resolver, and only the first is evidence. A read
  // failure must therefore cost a window, not produce the accusation directly
  // above — which blocks every send and does not self-correct.
  it('skips the window instead of accusing when the pointer cannot be read', async () => {
    (resolveChosenGuardianEndpoint as jest.Mock).mockRejectedValueOnce(new Error('storage unavailable'));
    (getGuardianCommitmentFromAccount as jest.Mock).mockReturnValue('newC');
    (identifyGuardianOperator as jest.Mock).mockResolvedValue(noBuiltInServesIt);
    const vault = makeVault({ publicKey: 'pk', guardianOperatorCommitment: 'oldC', guardianSyncStatus: 'in-sync' });

    expect(await resolveGuardianDrift(vault as never, 'pk')).toEqual({ status: 'in-sync', changed: false });

    expect(vault.setGuardianSyncStatus).not.toHaveBeenCalled();
    expect(identifyGuardianOperator).not.toHaveBeenCalled();
    expect(checkEndpointCommitment).not.toHaveBeenCalled();
  });

  // Placed here because it is the same class of bug one layer down: a value that
  // is silently wrong rather than a call that visibly fails.
  //
  // Every account's silent-drift run lives in ONE storage object, so an unserialized
  // read-modify-write lets two overlapping passes each read the object, mutate
  // their own account's entry, and write the whole thing back — the later write
  // dropping the earlier account's progress. The drift check is dispatched per
  // realm onto the single backend and the frontend's coalescing is module-local,
  // so the overlap is real. A dropped window means a stranded account never
  // reaches the run length its only prompt is gated on: it stays silently broken.
  // The skip must not arm the probe cooldown: an unread pointer is not a completed
  // probe, and charging it one would stretch a transient failure into a
  // multi-minute blind spot on an account that may genuinely be drifting.
  it('leaves the next window free to probe after an unreadable pointer', async () => {
    (resolveChosenGuardianEndpoint as jest.Mock).mockRejectedValueOnce(new Error('storage unavailable'));
    (getGuardianCommitmentFromAccount as jest.Mock).mockReturnValue('newC');
    (checkEndpointCommitment as jest.Mock).mockResolvedValue('match');
    (identifyGuardianOperator as jest.Mock).mockResolvedValue(noBuiltInServesIt);
    const vault = makeVault({
      publicKey: 'pk',
      guardianEndpoint: 'https://per-account.example',
      guardianOperatorCommitment: 'oldC',
      guardianSyncStatus: 'in-sync'
    });

    await resolveGuardianDrift(vault as never, 'pk');
    expect(checkEndpointCommitment).not.toHaveBeenCalled();

    // Immediately after — no fake-timer advance — the retry must actually probe.
    expect(await resolveGuardianDrift(vault as never, 'pk')).toEqual({ status: 'in-sync', changed: true });
    expect(checkEndpointCommitment).toHaveBeenCalledWith('https://per-account.example', 'newC');
  });
});

describe('CAS-stale repairs (the F-220 guard at the reconciler level)', () => {
  it('discards an identified repair whose binding write comes back stale, leaving status untouched', async () => {
    (getGuardianCommitmentFromAccount as jest.Mock).mockReturnValue('newC');
    (identifyGuardianOperator as jest.Mock).mockResolvedValue(identified('https://g'));
    const vault = makeVault({ publicKey: 'pk', guardianOperatorCommitment: 'oldC', guardianSyncStatus: 'in-sync' });
    vault.updateGuardianBinding.mockResolvedValue({ outcome: 'stale' as const });

    expect(await resolveGuardianDrift(vault as never, 'pk')).toEqual({ status: 'in-sync', changed: false });

    // The repair is dropped whole: no status write may survive a binding the
    // pass never looked at.
    expect(vault.setGuardianSyncStatus).not.toHaveBeenCalled();
  });

  it('releases the probe cooldown on a stale outcome, so the next tick re-derives instead of waiting a window', async () => {
    (getGuardianCommitmentFromAccount as jest.Mock).mockReturnValue('newC');
    (identifyGuardianOperator as jest.Mock).mockResolvedValue(identified('https://g'));
    const vault = makeVault({ publicKey: 'pk', guardianOperatorCommitment: 'oldC', guardianSyncStatus: 'in-sync' });
    vault.updateGuardianBinding.mockResolvedValueOnce({ outcome: 'stale' as const });

    await resolveGuardianDrift(vault as never, 'pk');
    // Immediately after — no fake-timer advance — the retry must re-probe and,
    // with the CAS now applying, complete the repair the stale pass discarded.
    expect(await resolveGuardianDrift(vault as never, 'pk')).toEqual({ status: 'in-sync', changed: true });
    expect(identifyGuardianOperator).toHaveBeenCalledTimes(2);
    expect(vault.setGuardianSyncStatus).toHaveBeenLastCalledWith('pk', 'in-sync');
  });

  it("applyUserGuardianEndpoint returns 'stale' and writes no status when the binding changed under it", async () => {
    (getGuardianCommitmentFromAccount as jest.Mock).mockReturnValue('cc');
    (verifyEndpointMatchesCommitment as jest.Mock).mockResolvedValue('match');
    const vault = makeVault({ publicKey: 'pk', guardianOperatorCommitment: 'old' });
    vault.updateGuardianBinding.mockResolvedValue({ outcome: 'stale' as const });

    expect(await applyUserGuardianEndpoint(vault as never, 'pk', 'https://mine')).toBe('stale');

    expect(vault.setGuardianSyncStatus).not.toHaveBeenCalled();
  });
});
