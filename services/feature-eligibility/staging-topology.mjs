const SCENARIOS = new Set(['cache_reuse']);

function reply(status, body) {
  return Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
}

export default {
  async fetch(request, env) {
    if (
      typeof env.TOPOLOGY_BEARER !== 'string' ||
      !env.TOPOLOGY_BEARER ||
      request.headers.get('Authorization') !== `Bearer ${env.TOPOLOGY_BEARER}`
    ) {
      return reply(403, { error: 'forbidden' });
    }

    const url = new URL(request.url);
    const match = /^\/scenario\/([a-z_]+)$/.exec(url.pathname);
    if (request.method !== 'POST' || request.body !== null || url.search || !match || !SCENARIOS.has(match[1])) {
      return reply(400, { error: 'bad_request' });
    }

    try {
      const control = env.TOPOLOGY_CONTROL.get(env.TOPOLOGY_CONTROL.idFromName('run-v1'));
      const result = await control.fetch(new Request(`https://topology.internal/scenario/${match[1]}`, { method: 'POST' }));
      if (!result.ok) return reply(503, { error: 'unavailable' });
      const value = await result.json();
      if (value?.scenario !== match[1] || !['passed', 'failed'].includes(value.status)) {
        return reply(503, { error: 'unavailable' });
      }
      return reply(200, { scenario: match[1], status: value.status });
    } catch {
      return reply(503, { error: 'unavailable' });
    }
  }
};

export function createRunController({ storage, now = Date.now, expiresAt, maxRuns, runScenario }) {
  return async request => {
    const url = new URL(request.url);
    const match = /^\/scenario\/([a-z_]+)$/.exec(url.pathname);
    if (request.method !== 'POST' || request.body !== null || url.search || !match || !SCENARIOS.has(match[1])) {
      return reply(400, { error: 'bad_request' });
    }
    if (!Number.isSafeInteger(expiresAt) || !Number.isInteger(maxRuns) || maxRuns < 1 || maxRuns > 20) {
      return reply(503, { error: 'unavailable' });
    }
    try {
      const admission = await storage.transaction(async transaction => {
        const current = await transaction.get('run') ?? { count: 0, active: false, expiresAt, maxRuns };
        const time = now();
        if (!Number.isSafeInteger(time) || time >= expiresAt || expiresAt - time > 900_000) return 'expired';
        if (
          !Number.isSafeInteger(current.count) || current.count < 0 || typeof current.active !== 'boolean' ||
          current.expiresAt !== expiresAt || current.maxRuns !== maxRuns
        ) return 'invalid';
        if (current.active || current.count >= maxRuns) return 'limited';
        await transaction.put('run', { ...current, count: current.count + 1, active: true });
        return 'accepted';
      });
      if (admission === 'limited') return reply(429, { error: 'limited' });
      if (admission !== 'accepted') return reply(503, { error: 'unavailable' });
      let outcome;
      try {
        outcome = await runScenario(match[1]);
      } finally {
        await storage.transaction(async transaction => {
          const current = await transaction.get('run');
          if (current?.active === true) await transaction.put('run', { ...current, active: false });
        });
      }
      if (!['passed', 'failed'].includes(outcome) || now() >= expiresAt) return reply(503, { error: 'unavailable' });
      return reply(200, { scenario: match[1], status: outcome });
    } catch {
      return reply(503, { error: 'unavailable' });
    }
  };
}

export async function runCacheScenario() {
  return 'failed';
}
