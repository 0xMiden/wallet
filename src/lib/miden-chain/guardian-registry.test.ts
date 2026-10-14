import {
  _resetGuardianRegistryForTest,
  getGuardiansRevision,
  getKnownGuardians,
  getNetworkGuardianEndpoints,
  getNetworkGuardians,
  setDocumentGuardians,
  subscribeGuardians
} from './guardian-registry';
import type { ResolvedGuardianOption } from './networks-config';

const option = (id: string, endpoint: string): ResolvedGuardianOption => ({
  id,
  name: id,
  operatedBy: id,
  location: 'EU',
  endpoint
});
const KODA = option('kodax', 'https://koda.example');
const NEW = option('new-one', 'https://new.example');

beforeEach(() => _resetGuardianRegistryForTest());

describe('the bundled list', () => {
  it('is the list of a network with no document, in GUARDIAN_OPTIONS order', () => {
    expect(getNetworkGuardians('testnet').map(o => o.id)).toEqual([
      'open-zeppelin',
      'gateway',
      'lambda-class',
      'kodax'
    ]);
    expect(getNetworkGuardianEndpoints('devnet')).toEqual(['https://guardian-devnet.openzeppelin.com']);
    expect(getNetworkGuardianEndpoints('localnet')).toEqual(['http://localhost:3000']);
  });

  it('is empty for a network no operator runs on', () => {
    expect(getNetworkGuardians('mainnet')).toEqual([]);
    expect(getNetworkGuardians('no-such-network')).toEqual([]);
  });

  it('is the same array on every read', () => {
    expect(getNetworkGuardians('testnet')).toBe(getNetworkGuardians('testnet'));
  });
});

describe('a document list', () => {
  it('replaces the bundled list of its network only, and does not add to it', () => {
    setDocumentGuardians('testnet', [KODA, NEW]);

    expect(getNetworkGuardians('testnet')).toEqual([KODA, NEW]);
    expect(getNetworkGuardianEndpoints('devnet')).toEqual(['https://guardian-devnet.openzeppelin.com']);
  });

  it('gives a network with no bundled operator its operators', () => {
    setDocumentGuardians('mainnet', [NEW]);

    expect(getNetworkGuardianEndpoints('mainnet')).toEqual(['https://new.example']);
  });

  it('puts the network back on the bundled list when a later document has no guardians section', () => {
    setDocumentGuardians('testnet', [NEW]);
    setDocumentGuardians('testnet', undefined);

    expect(getNetworkGuardians('testnet').map(o => o.id)).toEqual([
      'open-zeppelin',
      'gateway',
      'lambda-class',
      'kodax'
    ]);
  });

  it('tells listeners and moves the revision on each change', () => {
    const listener = jest.fn();
    const unsubscribe = subscribeGuardians(listener);

    setDocumentGuardians('testnet', [KODA]);
    setDocumentGuardians('testnet', [KODA, NEW]);
    setDocumentGuardians('testnet', undefined);
    expect(listener).toHaveBeenCalledTimes(3);
    expect(getGuardiansRevision()).toBe(3);

    unsubscribe();
    setDocumentGuardians('testnet', [NEW]);
    expect(listener).toHaveBeenCalledTimes(3);
  });

  it('keeps the array and tells no listener for a list equal to the one in use', () => {
    const listener = jest.fn();
    setDocumentGuardians('testnet', [KODA, NEW]);
    const inUse = getNetworkGuardians('testnet');
    subscribeGuardians(listener);

    // A refresh parses the same document into new objects.
    setDocumentGuardians('testnet', [{ ...KODA }, { ...NEW }]);

    expect(getNetworkGuardians('testnet')).toBe(inUse);
    expect(listener).not.toHaveBeenCalled();
  });

  it('keeps the bundled array and tells no listener for a document equal to the bundled list', () => {
    const listener = jest.fn();
    const bundled = getNetworkGuardians('devnet');
    subscribeGuardians(listener);

    setDocumentGuardians(
      'devnet',
      bundled.map(o => ({ ...o }))
    );

    expect(getNetworkGuardians('devnet')).toBe(bundled);
    expect(listener).not.toHaveBeenCalled();
  });

  it('counts a change of order, of a name or of an endpoint as a change', () => {
    const listener = jest.fn();
    setDocumentGuardians('testnet', [KODA, NEW]);
    subscribeGuardians(listener);

    setDocumentGuardians('testnet', [NEW, KODA]);
    setDocumentGuardians('testnet', [NEW, { ...KODA, name: 'Koda' }]);
    setDocumentGuardians('testnet', [NEW, { ...KODA, name: 'Koda', endpoint: 'https://koda-2.example' }]);

    expect(listener).toHaveBeenCalledTimes(3);
    expect(getNetworkGuardianEndpoints('testnet')).toEqual(['https://new.example', 'https://koda-2.example']);
  });

  it('counts a new, changed or removed about or kind text as a change, and an equal one as none', () => {
    const listener = jest.fn();
    setDocumentGuardians('testnet', [KODA]);
    subscribeGuardians(listener);

    setDocumentGuardians('testnet', [{ ...KODA, about: 'A custodian.' }]);
    setDocumentGuardians('testnet', [{ ...KODA, about: 'A custodian.' }]);
    setDocumentGuardians('testnet', [{ ...KODA, about: 'A digital asset custodian.' }]);
    setDocumentGuardians('testnet', [{ ...KODA, about: 'A digital asset custodian.', kind: 'Custody' }]);
    setDocumentGuardians('testnet', [KODA]);

    expect(listener).toHaveBeenCalledTimes(4);
    expect(getNetworkGuardians('testnet')[0]?.about).toBeUndefined();
  });

  it('does nothing when a network with no document list is told it has none', () => {
    const listener = jest.fn();
    subscribeGuardians(listener);

    setDocumentGuardians('testnet', undefined);

    expect(listener).not.toHaveBeenCalled();
    expect(getGuardiansRevision()).toBe(0);
  });
});

describe('getKnownGuardians', () => {
  it('lists the bundled operators of every network with no document', () => {
    expect(getKnownGuardians().map(o => o.endpoint)).toEqual(
      expect.arrayContaining([
        'https://guardian-testnet.openzeppelin.com',
        'https://guardian-testnet.kodax.com',
        'https://guardian-devnet.openzeppelin.com',
        'http://localhost:3000'
      ])
    );
  });

  it('lists a network by its document list, and a network only a document names', () => {
    setDocumentGuardians('testnet', [NEW]);
    setDocumentGuardians('mainnet', [KODA]);

    const endpoints = getKnownGuardians().map(o => o.endpoint);
    expect(endpoints).toEqual(expect.arrayContaining(['https://new.example', 'https://koda.example']));
    // Testnet's bundled operators are no longer known; devnet's and localnet's still are.
    expect(endpoints).not.toContain('https://guardian-testnet.openzeppelin.com');
    expect(endpoints).toEqual(
      expect.arrayContaining(['https://guardian-devnet.openzeppelin.com', 'http://localhost:3000'])
    );
  });
});
