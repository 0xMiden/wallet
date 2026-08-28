/**
 * operator-map maps each built-in Guardian operator's public key commitment
 * (fetched unauthenticated via GET /pubkey) to the ResolvedGuardianOption
 * that operates it, so an on-chain guardian commitment can be reverse-mapped
 * back to a known operator (or flagged as custom/rotated when no match is
 * found).
 *
 * `@openzeppelin/guardian-client` is normally auto-mocked to a jest.fn()
 * stub (see __mocks__/@openzeppelin/guardian-client.ts) but this suite needs
 * `getPubkey` to return specific per-endpoint commitments, so it overrides
 * the auto-mock with an explicit factory below. `jest.mock` calls are
 * hoisted above imports by the Jest transform, so it's safe to declare it
 * after the imports here (matches this repo's `import/first` lint rule).
 */
import { GuardianHttpClient } from '@openzeppelin/guardian-client';

import { MIDEN_NETWORK_NAME } from 'lib/miden-chain/constants';

import {
  buildOperatorKeyMap,
  checkEndpointCommitment,
  identifyGuardianOperator,
  normalizeHex,
  verifyEndpointMatchesCommitment
} from './operator-map';

// `unknown`, not `string`: the guardian client returns this field off an
// unchecked `response.json()` cast, so a real endpoint can serve any JSON type and
// a fixture pinned to `string` cannot express the case that took the fan-out down.
const MOCK_DEFAULT_PUBKEYS: Record<string, unknown> = {
  'https://guardian.openzeppelin.com': '0xAAA',
  'https://miden-guardian.dev.eu-north-3.gateway.fm': '0xBBB',
  'https://miden-guardian.lambdaclass.com': '0xCCC',
  'https://guardian-testnet.kodax.com': '0xDDD',
  // The devnet OpenZeppelin endpoint, so a lookup that resolved the wrong
  // network answers with a DIFFERENT key rather than with nothing.
  'https://guardian-stg.openzeppelin.com': '0xEEE',
  // The developer URL override, which is a selectable option in the onboarding
  // picker but must never be probed as a built-in operator.
  'https://dev-override.guardian.test': '0xFFF'
};

// What each endpoint's unauthenticated `GET /pubkey` answers. Mutable per case,
// so a test can have two built-ins claim ONE commitment — a collision the map has
// to decline rather than award to whichever answered first.
let mockPubkeyByEndpoint: Record<string, unknown> = { ...MOCK_DEFAULT_PUBKEYS };

jest.mock('@openzeppelin/guardian-client', () => ({
  GuardianHttpClient: class {
    constructor(public url: string) {}
    async getPubkey() {
      return { commitment: mockPubkeyByEndpoint[this.url] };
    }
  }
}));

// The network these probes run against when the caller names none. Held in a
// variable rather than pinned to the build default so a test can move the
// effective network away from the build-baked one — the whole point of the
// no-argument path below.
let mockEffectiveNetwork: MIDEN_NETWORK_NAME = MIDEN_NETWORK_NAME.TESTNET;
// The developer guardian-URL override. `getGuardianOptionsForNetwork` offers it as
// a selectable provider; the built-in set this module probes must not include it.
let mockGuardianUrlOverride = '';
jest.mock('lib/miden-chain/effective-endpoints', () => ({
  ...jest.requireActual('lib/miden-chain/effective-endpoints'),
  getEffectiveNetworkName: () => mockEffectiveNetwork,
  getEffectiveGuardianUrl: () => mockGuardianUrlOverride
}));

jest.mock('lib/miden/guardian/native-http', () => ({
  registerGuardianOrigin: jest.fn()
}));

afterEach(() => {
  jest.restoreAllMocks();
  mockPubkeyByEndpoint = { ...MOCK_DEFAULT_PUBKEYS };
});

describe('normalizeHex', () => {
  it('strips 0x and lowercases', () => {
    expect(normalizeHex('0xABC')).toBe('abc');
  });

  it('lowercases when there is no 0x prefix', () => {
    expect(normalizeHex('ABC')).toBe('abc');
  });
});

describe('buildOperatorKeyMap', () => {
  it('maps each reachable operator commitment (normalized) to its ResolvedGuardianOption', async () => {
    const map = await buildOperatorKeyMap(MIDEN_NETWORK_NAME.TESTNET);

    expect(map.get('aaa')?.id).toBe('open-zeppelin');
    expect(map.get('bbb')?.id).toBe('gateway');
    expect(map.get('ccc')?.id).toBe('lambda-class');
    expect(map.get('ddd')?.id).toBe('kodax');
  });

  it('skips an operator whose endpoint is unreachable, without throwing', async () => {
    jest.spyOn(GuardianHttpClient.prototype, 'getPubkey').mockImplementationOnce(async () => {
      throw new Error('network unreachable');
    });

    const map = await buildOperatorKeyMap(MIDEN_NETWORK_NAME.TESTNET);

    // The first operator (open-zeppelin) fails and is skipped; the other
    // built-in operators are still present.
    expect(map.get('aaa')).toBeUndefined();
    expect(map.get('bbb')?.id).toBe('gateway');
    expect(map.get('ccc')?.id).toBe('lambda-class');
    expect(map.get('ddd')?.id).toBe('kodax');
  });
});

// `network` is optional on both entry points and is forwarded UNDEFAULTED, so
// the resolution lands on `getGuardianOptionsForNetwork` — the EFFECTIVE
// network. A default parameter here (the build-baked `DEFAULT_NETWORK`) meant
// that with a developer endpoint override active the wallet probed a different
// network's operator set and reported every one of them as not holding the
// account's guardian key. Every other call in this file names its network, so
// only a no-argument call can see the difference.
describe('the no-argument default', () => {
  afterEach(() => {
    mockEffectiveNetwork = MIDEN_NETWORK_NAME.TESTNET;
  });

  it('builds the map from the effective network operator set', async () => {
    mockEffectiveNetwork = MIDEN_NETWORK_NAME.DEVNET;

    const map = await buildOperatorKeyMap();

    // Devnet runs exactly one built-in operator, and it is not one of the four
    // the build-baked network would have probed.
    expect(map.get('eee')?.endpoint).toBe('https://guardian-stg.openzeppelin.com');
    expect(map.get('aaa')).toBeUndefined();
    expect(map.size).toBe(1);
  });

  it('identifies an operator against the effective network operator set', async () => {
    mockEffectiveNetwork = MIDEN_NETWORK_NAME.DEVNET;

    expect(await identifyGuardianOperator('0xEEE')).toEqual({
      outcome: 'identified',
      operator: expect.objectContaining({ id: 'open-zeppelin' })
    });
    // The testnet operator's key is not reachable from devnet — a commitment
    // that only the build default's set holds must not resolve.
    expect(await identifyGuardianOperator('aaa')).toEqual({ outcome: 'none' });
  });
});

describe('identifyGuardianOperator', () => {
  it('identifies the operator whose pubkey matches the on-chain commitment', async () => {
    const lookup = await identifyGuardianOperator('aaa', MIDEN_NETWORK_NAME.TESTNET); // unprefixed on-chain form
    expect(lookup).toEqual({ outcome: 'identified', operator: expect.objectContaining({ id: 'open-zeppelin' }) });
  });

  it('reports none when every built-in answered and none of them matches (custom/rotated)', async () => {
    expect(await identifyGuardianOperator('deadbeef', MIDEN_NETWORK_NAME.TESTNET)).toEqual({ outcome: 'none' });
  });

  // The distinction this type exists for. `resolveGuardianDrift` reads a `'none'`
  // as "the guardian is a custom operator, so believe the endpoint the account
  // already stores" and PERMANENTLY advances its commitment baseline on it. A
  // round in which the built-ins simply did not answer proves nothing of the kind,
  // and reporting it as `'none'` handed that permanence to anyone who could make
  // the built-ins unreachable — a captive portal, an offline device, or a targeted
  // outage.
  it('reports unavailable when no built-in answered at all', async () => {
    jest.spyOn(GuardianHttpClient.prototype, 'getPubkey').mockImplementation(async () => {
      throw new Error('network unreachable');
    });

    expect(await identifyGuardianOperator('deadbeef', MIDEN_NETWORK_NAME.TESTNET)).toEqual({
      outcome: 'unavailable'
    });
  });

  // A partial round cannot rule out that the built-in which stayed silent is the
  // one holding the key, so it is not a `'none'` either — otherwise suppressing a
  // SINGLE operator would buy the same permanence as suppressing all four.
  it('reports unavailable when one built-in did not answer, even though the others did', async () => {
    jest.spyOn(GuardianHttpClient.prototype, 'getPubkey').mockImplementationOnce(async () => {
      throw new Error('network unreachable');
    });

    expect(await identifyGuardianOperator('deadbeef', MIDEN_NETWORK_NAME.TESTNET)).toEqual({
      outcome: 'unavailable'
    });
  });

  // A match is complete evidence on its own: the operator served exactly this
  // key, and nothing a silent sibling might have said could subtract from that.
  // Requiring a complete round here too would strand every account whose guardian
  // is a built-in for as long as any OTHER built-in is down.
  it('still identifies a matching operator when a different built-in is unreachable', async () => {
    jest.spyOn(GuardianHttpClient.prototype, 'getPubkey').mockImplementationOnce(async () => {
      throw new Error('network unreachable');
    });

    // open-zeppelin (probed first) is the one that fails; gateway still answers.
    expect(await identifyGuardianOperator('bbb', MIDEN_NETWORK_NAME.TESTNET)).toEqual({
      outcome: 'identified',
      operator: expect.objectContaining({ id: 'gateway' })
    });
  });

  // Two built-ins claiming one guardian key cannot both be the operator the chain
  // names, so one of them is misconfigured or answering for a host it does not
  // own. The wallet cannot tell which, and this answer decides which endpoint an
  // account is repaired TO — so it names neither, and says so as `'unavailable'`
  // rather than as `'none'`, which a caller would read as licence to believe a
  // stored endpoint instead.
  it('names no operator when two built-ins serve the same commitment', async () => {
    // kodax, probed LAST, claims the key open-zeppelin already served. Under
    // arrival-order insertion the outcome depended on which reply landed first;
    // now neither is named, in either order.
    mockPubkeyByEndpoint['https://guardian-testnet.kodax.com'] = '0xAAA';

    expect(await identifyGuardianOperator('aaa', MIDEN_NETWORK_NAME.TESTNET)).toEqual({ outcome: 'unavailable' });
  });

  it('declines the contested commitment without losing the ones only one operator claims', async () => {
    mockPubkeyByEndpoint['https://guardian-testnet.kodax.com'] = '0xAAA';

    expect(await identifyGuardianOperator('aaa', MIDEN_NETWORK_NAME.TESTNET)).toEqual({ outcome: 'unavailable' });
    expect(await identifyGuardianOperator('bbb', MIDEN_NETWORK_NAME.TESTNET)).toEqual({
      outcome: 'identified',
      operator: expect.objectContaining({ id: 'gateway' })
    });
  });

  // A third claimant must not un-contest the key by overwriting the marker.
  it('keeps a commitment contested when a third built-in claims it too', async () => {
    mockPubkeyByEndpoint['https://miden-guardian.lambdaclass.com'] = '0xAAA';
    mockPubkeyByEndpoint['https://guardian-testnet.kodax.com'] = '0xAAA';

    expect(await identifyGuardianOperator('aaa', MIDEN_NETWORK_NAME.TESTNET)).toEqual({ outcome: 'unavailable' });
  });
});

// The corroboration source has to be wallet CODE. `getGuardianOptionsForNetwork`
// appends the developer guardian-URL override — persisted, user-settable settings
// state — and drift reconciliation lets a member of this set overwrite the
// endpoint stored on an account, so a URL typed into dev settings must not appear
// here.
describe('one operator serving a nonsense commitment type', () => {
  // `normalizeHex` calls `.startsWith` on whatever came back, and the fold that
  // does so runs OUTSIDE the per-operator catch — so a single built-in answering
  // `{"commitment": 1234}` threw a TypeError out of the whole fan-out. Every
  // caller then lost its round: drift reconciliation died for EVERY account on the
  // device, including accounts pointed at other, healthy operators, which is the
  // opposite of the isolation this module exists to provide. Worse, one of those
  // call sites throws after writing `'resolving'`, stranding the account in a
  // status that blocks every transaction and shows no banner.
  it('does not take the whole round down with it', async () => {
    mockPubkeyByEndpoint['https://guardian.openzeppelin.com'] = 1234;

    const lookup = await identifyGuardianOperator('0xBBB', MIDEN_NETWORK_NAME.TESTNET);

    expect(lookup).toEqual({
      outcome: 'identified',
      operator: expect.objectContaining({ endpoint: 'https://miden-guardian.dev.eu-north-3.gateway.fm' })
    });
  });

  // And it counts as "did not answer", not as "answered with something unusable":
  // an endpoint serving a nonsense type is exactly as informative as one that is
  // down, so it must not complete the round that a `'none'` verdict requires. A
  // `'none'` is what authorizes an accusation, and buying one by making a single
  // operator misbehave is precisely what the completeness rule prevents.
  it('leaves the round incomplete, so no built-in can be ruled out', async () => {
    mockPubkeyByEndpoint['https://guardian.openzeppelin.com'] = { nested: 'object' };

    const lookup = await identifyGuardianOperator('0xNOBODYSERVESTHIS', MIDEN_NETWORK_NAME.TESTNET);

    expect(lookup.outcome).toBe('unavailable');
  });

  // The same field reaches `checkEndpointCommitment`, which the drift reconciler
  // and the manual-URL apply both gate on. It must fail closed, not throw.
  it('reads as unreachable through checkEndpointCommitment', async () => {
    mockPubkeyByEndpoint['https://guardian.openzeppelin.com'] = true;

    await expect(checkEndpointCommitment('https://guardian.openzeppelin.com', '0xAAA')).resolves.toBe('unreachable');
  });
});

describe('the built-in set excludes the developer URL override', () => {
  afterEach(() => {
    mockGuardianUrlOverride = '';
  });

  it('does not probe the override endpoint', async () => {
    mockGuardianUrlOverride = 'https://dev-override.guardian.test';

    const map = await buildOperatorKeyMap(MIDEN_NETWORK_NAME.TESTNET);

    expect(map.get('fff')).toBeUndefined();
    expect(map.get('aaa')?.id).toBe('open-zeppelin');
  });

  it('does not let the override corroborate a commitment', async () => {
    mockGuardianUrlOverride = 'https://dev-override.guardian.test';

    expect(await identifyGuardianOperator('0xFFF', MIDEN_NETWORK_NAME.TESTNET)).toEqual({ outcome: 'none' });
  });
});

// The tri-state exists so a caller can tell "it said no" from "it never
// answered": collapsing them makes a network blip indistinguishable from a
// genuine out-of-band guardian switch, and the drift reconciler acts on that
// difference.
describe('checkEndpointCommitment', () => {
  it('reports a match when the endpoint pubkey commitment matches (normalized)', async () => {
    expect(await checkEndpointCommitment('https://guardian.openzeppelin.com', '0xaaa')).toBe('match');
  });

  it('reports a mismatch when the endpoint answers with a different key', async () => {
    expect(await checkEndpointCommitment('https://guardian.openzeppelin.com', 'bbb')).toBe('mismatch');
  });

  it('reports unreachable when the endpoint fetch throws', async () => {
    jest.spyOn(GuardianHttpClient.prototype, 'getPubkey').mockImplementationOnce(async () => {
      throw new Error('network unreachable');
    });

    expect(await checkEndpointCommitment('https://guardian.openzeppelin.com', 'aaa')).toBe('unreachable');
  });

  // An answer carrying no commitment is not a guardian answering, so it is no
  // more evidence of a mismatch than a dropped connection is.
  it('reports unreachable when the endpoint answers without a commitment', async () => {
    expect(await checkEndpointCommitment('https://not-a-guardian.test', 'aaa')).toBe('unreachable');
  });

  // This runs from the ~3s sync tick and the guardian client exposes no abort, so
  // an unbounded wait would park one request per tick against a hung operator.
  it('reports unreachable when the endpoint never answers', async () => {
    jest.useFakeTimers();
    jest.spyOn(GuardianHttpClient.prototype, 'getPubkey').mockImplementationOnce(() => new Promise(() => {}));

    const verdict = checkEndpointCommitment('https://hung.guardian', 'aaa');
    await jest.advanceTimersByTimeAsync(5_000);

    expect(await verdict).toBe('unreachable');
    jest.useRealTimers();
  });
});

describe('verifyEndpointMatchesCommitment', () => {
  it('returns true when the endpoint pubkey commitment matches (normalized)', async () => {
    expect(await verifyEndpointMatchesCommitment('https://guardian.openzeppelin.com', '0xaaa')).toBe(true);
  });

  it('returns false when the endpoint pubkey commitment does not match', async () => {
    expect(await verifyEndpointMatchesCommitment('https://guardian.openzeppelin.com', 'bbb')).toBe(false);
  });

  // Boolean by design for callers about to WRITE the endpoint: unreachable and
  // mismatched are the same answer there — do not persist the unconfirmed.
  it('returns false when the endpoint fetch throws', async () => {
    jest.spyOn(GuardianHttpClient.prototype, 'getPubkey').mockImplementationOnce(async () => {
      throw new Error('network unreachable');
    });

    expect(await verifyEndpointMatchesCommitment('https://guardian.openzeppelin.com', 'aaa')).toBe(false);
  });

  // This is one-shot and user-initiated, so it gets a far longer budget than the
  // repeating sync tick's: on the tick a slow operator is simply retried in 3s,
  // whereas here a `false` is shown to the user as "that URL is the WRONG
  // operator" and blocks the write. A cold-starting but perfectly correct
  // self-hosted guardian must not be reported that way.
  it('waits well past the tick budget before giving up on a slow endpoint', async () => {
    jest.useFakeTimers();
    jest
      .spyOn(GuardianHttpClient.prototype, 'getPubkey')
      .mockImplementationOnce(() => new Promise(resolve => setTimeout(() => resolve({ commitment: '0xAAA' }), 12_000)));

    const verdict = verifyEndpointMatchesCommitment('https://slow.self-hosted.test', 'aaa');
    await jest.advanceTimersByTimeAsync(12_000);

    expect(await verdict).toBe(true);
    jest.useRealTimers();
  });

  it('still gives up eventually on an endpoint that never answers', async () => {
    jest.useFakeTimers();
    jest.spyOn(GuardianHttpClient.prototype, 'getPubkey').mockImplementationOnce(() => new Promise(() => {}));

    const verdict = verifyEndpointMatchesCommitment('https://hung.self-hosted.test', 'aaa');
    await jest.advanceTimersByTimeAsync(20_000);

    expect(await verdict).toBe(false);
    jest.useRealTimers();
  });
});

// On mobile, guardian traffic reaches the network only through the CapacitorHttp
// CORS bypass, and that interceptor routes REGISTERED origins only. The built-ins
// are pre-seeded, so this is what makes a custom / self-hosted endpoint work —
// and the custom endpoint is exactly what the drift reconciler and the
// manual-URL apply hand to these probes.
describe('mobile CORS-bypass registration', () => {
  const { registerGuardianOrigin } = jest.requireMock('lib/miden/guardian/native-http');

  beforeEach(() => registerGuardianOrigin.mockClear());

  it('registers the probed origin from checkEndpointCommitment', async () => {
    await checkEndpointCommitment('https://custom.guardian.test', 'aaa');
    expect(registerGuardianOrigin).toHaveBeenCalledWith('https://custom.guardian.test');
  });

  it('registers the probed origin from verifyEndpointMatchesCommitment', async () => {
    await verifyEndpointMatchesCommitment('https://custom.guardian.test', 'aaa');
    expect(registerGuardianOrigin).toHaveBeenCalledWith('https://custom.guardian.test');
  });

  it('registers every built-in origin it probes from buildOperatorKeyMap', async () => {
    await buildOperatorKeyMap(MIDEN_NETWORK_NAME.TESTNET);
    expect(registerGuardianOrigin).toHaveBeenCalledWith('https://guardian.openzeppelin.com');
    expect(registerGuardianOrigin).toHaveBeenCalledWith('https://miden-guardian.lambdaclass.com');
  });
});
