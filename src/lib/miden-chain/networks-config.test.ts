import {
  GUARDIAN_BRAND_NAME,
  GUARDIAN_OPTIONS,
  MIDEN_NETWORK_ENDPOINTS,
  MIDEN_NETWORK_NAME,
  MIDEN_NETWORKS
} from './networks-config';

describe('MIDEN_NETWORKS', () => {
  // The dApp layer and the Network labels read this list: a network missing from it is refused or named as another.
  it('lists every network the wallet can be on, mainnet included, at its build RPC', () => {
    expect(MIDEN_NETWORKS.map(network => network.id).sort()).toEqual(Object.values(MIDEN_NETWORK_NAME).sort());
    for (const network of MIDEN_NETWORKS) {
      expect(network.rpcBaseURL).toBe(MIDEN_NETWORK_ENDPOINTS.get(network.id));
    }
    expect(MIDEN_NETWORKS.find(network => network.id === MIDEN_NETWORK_NAME.MAINNET)?.name).toBe('Mainnet');
  });
});

/**
 * #464 — Guardian provider display names must be spelled canonically and come
 * from the single GUARDIAN_OPTIONS source, so onboarding, Settings, Activity,
 * recovery and success/error copy all render the same brand name.
 */
describe('GUARDIAN_OPTIONS canonical provider names (#464)', () => {
  const byId = (id: string) => {
    const option = GUARDIAN_OPTIONS.find(o => o.id === id);
    if (!option) throw new Error(`no guardian option with id "${id}"`);
    return option;
  };

  it('spells OpenZeppelin as one word', () => {
    const oz = byId('open-zeppelin');
    expect(oz.name).toBe('OpenZeppelin');
    expect(oz.operatedBy).toBe('OpenZeppelin');
  });

  it('spells LambdaClass as one word', () => {
    const lc = byId('lambda-class');
    expect(lc.name).toBe('LambdaClass');
    expect(lc.operatedBy).toBe('LambdaClass');
  });

  it('keeps Gateway as the canonical operator brand', () => {
    expect(byId('gateway').operatedBy).toBe('Gateway');
  });

  it('derives descriptive names from the canonical brand (no drifting literal)', () => {
    expect(byId('gateway').name).toBe(`${GUARDIAN_BRAND_NAME.gateway} Operator`);
  });

  it('never uses a non-canonical spelling for any provider', () => {
    const forbidden = ['Open Zeppelin', 'Open-Zeppelin', 'Lambda Class'];
    for (const option of GUARDIAN_OPTIONS) {
      for (const bad of forbidden) {
        expect(option.name).not.toContain(bad);
        expect(option.operatedBy).not.toContain(bad);
      }
    }
  });
});
