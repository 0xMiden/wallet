import { createService } from './worker.mjs';
import topology, { createRunController, runCacheScenario } from './staging-topology.mjs';

const policy = {
  network: 'testnet',
  version: 13,
  features: { earn: true },
  swap: { etaUrl: 'https://solver.example' },
  geo: { wallet: {}, earn: { 'block NY state': 'yes', 'block UK': 'yes' } }
};

function syntheticEnv(env) {
  const allowed = { limit: async () => ({ success: true }) };
  return {
    ...env,
    ALLOWED_ORIGINS: '["https://wallet.example"]',
    MAXMIND_ACCOUNT_ID: 'synthetic',
    MAXMIND_LICENSE_KEY: 'synthetic',
    CALLER_HASH_SECRET: 'synthetic-secret-32-characters-minimum',
    MAXMIND_DAILY_QUERY_LIMIT: '8',
    CALLER_RATE_LIMIT: allowed,
    COLO_RATE_LIMIT: allowed
  };
}

function fixedFetch(onLookup) {
  return async url => {
    if (String(url) === 'https://raw.githubusercontent.com/0xMiden/wallet-config/main/testnet.json') return Response.json(policy);
    if (String(url) === 'https://geoip.maxmind.com/geoip/v2.1/city/192.0.2.1') {
      onLookup();
      return Response.json({ country: { iso_code: 'US' }, subdivisions: [{ iso_code: 'CA' }] });
    }
    throw new Error('Unexpected staging upstream');
  };
}

export class EligibilityGuard {
  constructor(state, env) {
    this.reservations = 0;
    const service = createService({ fetchImpl: fixedFetch(() => {}) });
    this.delegate = new service.EligibilityGuard(state, syntheticEnv(env));
  }

  async fetch(request) {
    if (request.method === 'GET' && new URL(request.url).pathname === '/proof-counters') {
      return Response.json({ reservations: this.reservations });
    }
    const result = await this.delegate.fetch(request);
    if (new URL(request.url).pathname === '/lease' && result.ok) this.reservations++;
    return result;
  }

  async alarm() {
    return this.delegate.alarm();
  }
}

export class CallerEligibilityGuard {
  constructor(state, env) {
    this.lookups = 0;
    this.writes = 0;
    const service = createService({ fetchImpl: fixedFetch(() => { this.lookups++; }) });
    this.delegate = new service.CallerEligibilityGuard(state, syntheticEnv(env));
    const storage = this.delegate.storage;
    this.delegate.storage = new Proxy(storage, {
      get: (target, key) => {
        if (key === 'transaction') {
          return callback => target.transaction(tx => callback(new Proxy(tx, {
            get: (inner, property) => {
              if (property === 'put') {
                return async (name, value) => {
                  const result = await inner.put(name, value);
                  if (name.startsWith('caller:')) this.writes++;
                  return result;
                };
              }
              const value = inner[property];
              return typeof value === 'function' ? value.bind(inner) : value;
            }
          })));
        }
        const value = target[key];
        return typeof value === 'function' ? value.bind(target) : value;
      }
    });
  }

  async fetch(request) {
    if (request.method === 'GET' && new URL(request.url).pathname === '/proof-counters') {
      return Response.json({ lookups: this.lookups, writes: this.writes });
    }
    return this.delegate.fetch(request);
  }

  async alarm() {
    return this.delegate.alarm();
  }
}

export class TopologyControl {
  constructor(state, env) {
    const scenario = async () => {
      const caller = env.CALLER_GUARD.get(env.CALLER_GUARD.idFromName('cache:TST'));
      const budget = env.ELIGIBILITY_GUARD.get(env.ELIGIBILITY_GUARD.idFromName('global-v1'));
      const service = createService({ fetchImpl: fixedFetch(() => {}) });
      const serviceEnv = syntheticEnv(env);
      const counters = async () => ({
        ...await (await caller.fetch('https://topology.internal/proof-counters')).json(),
        ...await (await budget.fetch('https://topology.internal/proof-counters')).json()
      });
      return runCacheScenario({ service: { fetch: request => service.fetch(request, serviceEnv) }, counters });
    };
    this.handle = createRunController({
      storage: state.storage,
      expiresAt: Number(env.TOPOLOGY_RUN_UNTIL),
      maxRuns: Number(env.TOPOLOGY_RUN_MAX),
      runScenario: scenario
    });
  }

  async fetch(request) {
    return this.handle(request);
  }
}

export default topology;
