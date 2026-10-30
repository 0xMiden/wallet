import { createService } from './worker.mjs';
import topology, {
  createRunController,
  runBudgetScenario,
  runCacheScenario,
  runColoScenario,
  runFailureScenario,
  runNativeRateScenario,
  runRateScenario,
  runWiredRateScenario,
  runRestartScenario
} from './staging-topology.mjs';

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
    MAXMIND_DAILY_QUERY_LIMIT: '16',
    CALLER_RATE_LIMIT: allowed,
    COLO_RATE_LIMIT: allowed
  };
}

function fixedFetch(onLookup) {
  return async url => {
    if (String(url) === 'https://raw.githubusercontent.com/0xMiden/wallet-config/main/testnet.json')
      return Response.json(policy);
    if (/^https:\/\/geoip\.maxmind\.com\/geoip\/v2\.1\/city\/(?:192\.0\.2|198\.51\.100)\.(?:[1-9]|1[0-9])$/.test(String(url))) {
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
    if (request.method === 'GET' && new URL(request.url).pathname === '/proof-budget') {
      const budget = await this.delegate.storage.get('budget');
      return Response.json({ count: budget?.day === new Date().toISOString().slice(0, 10) ? budget.count : 0 });
    }
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
    const service = createService({
      fetchImpl: fixedFetch(() => {
        this.lookups++;
      })
    });
    this.delegate = new service.CallerEligibilityGuard(state, syntheticEnv(env));
    const storage = this.delegate.storage;
    this.delegate.storage = new Proxy(storage, {
      get: (target, key) => {
        if (key === 'transaction') {
          return callback =>
            target.transaction(tx =>
              callback(
                new Proxy(tx, {
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
                })
              )
            );
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

export class RestartProof {
  constructor(state, env) {
    this.state = state;
    this.env = syntheticEnv(env);
    this.clock = Date.UTC(2099, 0, 1, 12);
    this.stage = 0;
    this.service = createService({ fetchImpl: fixedFetch(() => {}), now: () => this.clock });
    this.delegate = new this.service.EligibilityGuard(state, this.env);
  }

  async fetch(request) {
    const sequence = ['reserve', 'restart', 'replay', 'advance', 'oldDay', 'newDay'];
    const step = new URL(request.url).pathname.slice(1);
    if (request.method !== 'POST' || sequence[this.stage] !== step) return new Response(null, { status: 400 });
    this.stage++;
    try {
      if (step === 'restart') {
        this.delegate = new this.service.EligibilityGuard(this.state, this.env);
        return Response.json({ count: (await this.state.storage.get('budget'))?.count });
      }
      if (step === 'advance') {
        this.clock += 86_400_000;
        return Response.json({ advanced: true });
      }
      const day = step === 'oldDay' ? '2099-01-01' : new Date(this.clock).toISOString().slice(0, 10);
      const leaseId = '00000000-0000-4000-8000-000000000099';
      const response = await this.delegate.fetch(
        new Request('https://eligibility.internal/lease', {
          method: 'POST',
          body: JSON.stringify({ day, deadline: this.clock + 5000, leaseId, count: 4 })
        })
      );
      if (step === 'oldDay') return Response.json({ reserved: response.ok });
      const body = await response.json();
      return Response.json({ granted: body.count, count: (await this.state.storage.get('budget'))?.count });
    } catch {
      return new Response(null, { status: 503 });
    }
  }

  async alarm() {
    return this.delegate.alarm();
  }
}

export class TopologyControl {
  constructor(state, env) {
    const scenario = async name => {
      const caller = env.CALLER_GUARD.get(env.CALLER_GUARD.idFromName('cache:TST'));
      const budget = env.ELIGIBILITY_GUARD.get(env.ELIGIBILITY_GUARD.idFromName('global-v1'));
      const service = createService({ fetchImpl: fixedFetch(() => {}) });
      const serviceEnv = syntheticEnv(env);
      if (name === 'restart_day') {
        const target = env.RESTART_PROOF.get(env.RESTART_PROOF.idFromName('fixed'));
        const probe = {
          step: async name => {
            const response = await target.fetch(`https://topology.internal/${name}`, { method: 'POST' });
            if (!response.ok) throw new Error('Restart proof step failed');
            return response.json();
          }
        };
        return runRestartScenario({ probe });
      }
      if (name === 'failure_behavior') {
        let attempts = 0;
        const adapter = {
          fetch: (request, mode) => {
            let current = 0;
            const guard = {
              idFromName: () => 'fixed',
              get: () => ({
                fetch: async () => {
                  attempts++;
                  current++;
                  if (mode === 'overload') throw Object.assign(new Error('synthetic overload'), { overloaded: true });
                  if (current === 1) throw Object.assign(new Error('synthetic retry'), { retryable: true });
                  return Response.json({ ready: true });
                }
              })
            };
            return service.fetch(request, { ...serviceEnv, CALLER_GUARD: guard });
          }
        };
        return runFailureScenario({ service: adapter, counters: async () => ({ attempts }) });
      }
      if (name === 'native_rate') {
        return runNativeRateScenario({
          caller: env.TOPOLOGY_CALLER_RATE,
          colo: env.TOPOLOGY_COLO_RATE,
          nonce: crypto.randomUUID().replaceAll('-', '')
        });
      }
      if (name === 'wired_rate') {
        let objects = 0;
        const monitored = namespace => ({
          idFromName: name => {
            objects++;
            return namespace.idFromName(`wired-rate:${name}`);
          },
          get: id => {
            objects++;
            return namespace.get(id);
          }
        });
        const boundEnv = {
          ...serviceEnv,
          CALLER_GUARD: monitored(env.CALLER_GUARD),
          ELIGIBILITY_GUARD: monitored(env.ELIGIBILITY_GUARD),
          CALLER_RATE_LIMIT: env.TOPOLOGY_CALLER_RATE,
          COLO_RATE_LIMIT: env.TOPOLOGY_COLO_RATE
        };
        return runWiredRateScenario({
          service: { fetch: request => service.fetch(request, boundEnv) },
          counters: async () => ({ objects }),
          onFailure: stage => console.error(`topology wired_rate failed at ${stage}`)
        });
      }
      if (name === 'rate_refusal') {
        let objects = 0;
        const monitored = namespace => ({
          idFromName: name => {
            objects++;
            return namespace.idFromName(name);
          },
          get: id => {
            objects++;
            return namespace.get(id);
          }
        });
        const rateEnv = {
          ...serviceEnv,
          CALLER_GUARD: monitored(env.CALLER_GUARD),
          ELIGIBILITY_GUARD: monitored(env.ELIGIBILITY_GUARD)
        };
        const adapter = {
          fetch: (request, refusal) =>
            service.fetch(request, {
              ...rateEnv,
              CALLER_RATE_LIMIT: { limit: async () => ({ success: refusal !== 'caller' }) },
              COLO_RATE_LIMIT: { limit: async () => ({ success: refusal !== 'colo' }) }
            })
        };
        return runRateScenario({ service: adapter, counters: async () => ({ objects }) });
      }
      if (name === 'shared_budget') {
        const counters = async () => (await budget.fetch('https://topology.internal/proof-budget')).json();
        return runBudgetScenario({ budget, counters });
      }
      if (name === 'colo_isolation') {
        const iad = env.CALLER_GUARD.get(env.CALLER_GUARD.idFromName('cache:IAD'));
        const fra = env.CALLER_GUARD.get(env.CALLER_GUARD.idFromName('cache:FRA'));
        const counters = async () => ({
          IAD: (await (await iad.fetch('https://topology.internal/proof-counters')).json()).lookups,
          FRA: (await (await fra.fetch('https://topology.internal/proof-counters')).json()).lookups,
          reservations: (await (await budget.fetch('https://topology.internal/proof-counters')).json()).reservations
        });
        return runColoScenario({ service: { fetch: request => service.fetch(request, serviceEnv) }, counters });
      }
      const counters = async () => ({
        ...(await (await caller.fetch('https://topology.internal/proof-counters')).json()),
        ...(await (await budget.fetch('https://topology.internal/proof-counters')).json())
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
