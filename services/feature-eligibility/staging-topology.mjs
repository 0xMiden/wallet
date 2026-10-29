const SCENARIOS = new Set(['cache_reuse', 'colo_isolation', 'shared_budget']);

function reply(status, body) {
  return Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
}

async function emptyBody(request) {
  if (request.body === null) return true;
  if (request.headers.get('Content-Length') !== '0') return false;
  const reader = request.body.getReader();
  let timer;
  try {
    return await Promise.race([
      (async () => {
        for (let count = 0; count < 2; count++) {
          const chunk = await reader.read();
          if (chunk.done) return true;
          if (chunk.value?.byteLength) return false;
        }
        return false;
      })(),
      new Promise(resolve => { timer = setTimeout(() => resolve(false), 1000); })
    ]);
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
    void reader.cancel().catch(() => {});
  }
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
    if (request.method !== 'POST' || url.search || !match || !SCENARIOS.has(match[1]) || !(await emptyBody(request))) {
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
    if (request.method !== 'POST' || url.search || !match || !SCENARIOS.has(match[1]) || !(await emptyBody(request))) {
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

export async function runCacheScenario({ service, counters }) {
  const fixedRequest = () => {
    const request = new Request('https://topology.invalid/v1/eligibility?network=testnet', {
      headers: { 'CF-Connecting-IP': '192.0.2.1', Origin: 'https://wallet.example' }
    });
    Object.defineProperty(request, 'cf', { value: { colo: 'TST' } });
    return request;
  };
  const validCounters = value =>
    value && ['lookups', 'writes', 'reservations'].every(key => Number.isSafeInteger(value[key]) && value[key] >= 0);
  try {
    const before = await counters();
    const first = await service.fetch(fixedRequest());
    const afterMiss = await counters();
    const second = await service.fetch(fixedRequest());
    const afterHit = await counters();
    if (![before, afterMiss, afterHit].every(validCounters) || !first.ok || !second.ok) return 'failed';
    const firstBody = await first.json();
    const secondBody = await second.json();
    const expected = { network: 'testnet', version: 13, allowed: { wallet: true, earn: true, swap: true } };
    if (JSON.stringify(firstBody) !== JSON.stringify(expected) || JSON.stringify(secondBody) !== JSON.stringify(expected)) return 'failed';
    if (!['lookups', 'writes', 'reservations'].every(key => afterMiss[key] === before[key] + 1 && afterHit[key] === afterMiss[key])) return 'failed';
    return 'passed';
  } catch {
    return 'failed';
  }
}

export async function runColoScenario({ service, counters }) {
  const fixedRequest = colo => {
    const request = new Request('https://topology.invalid/v1/eligibility?network=testnet', {
      headers: { 'CF-Connecting-IP': '192.0.2.2', Origin: 'https://wallet.example' }
    });
    Object.defineProperty(request, 'cf', { value: { colo } });
    return request;
  };
  const valid = value => value && ['IAD', 'FRA', 'reservations'].every(key => Number.isSafeInteger(value[key]) && value[key] >= 0);
  try {
    const before = await counters();
    const first = await service.fetch(fixedRequest('IAD'));
    const afterFirst = await counters();
    const second = await service.fetch(fixedRequest('FRA'));
    const afterSecond = await counters();
    if (![before, afterFirst, afterSecond].every(valid) || !first.ok || !second.ok) return 'failed';
    const expected = { network: 'testnet', version: 13, allowed: { wallet: true, earn: true, swap: true } };
    if (JSON.stringify(await first.json()) !== JSON.stringify(expected) || JSON.stringify(await second.json()) !== JSON.stringify(expected)) return 'failed';
    if (afterFirst.IAD !== before.IAD + 1 || afterFirst.FRA !== before.FRA || afterFirst.reservations !== before.reservations + 1) return 'failed';
    if (afterSecond.IAD !== afterFirst.IAD || afterSecond.FRA !== afterFirst.FRA + 1 || afterSecond.reservations !== afterFirst.reservations + 1) return 'failed';
    return 'passed';
  } catch {
    return 'failed';
  }
}

export async function runBudgetScenario({ budget, counters, now = Date.now }) {
  try {
    const readCount = async () => {
      const value = (await counters())?.count;
      if (!Number.isSafeInteger(value) || value < 0 || value > 16) throw new Error('Invalid staging count');
      return value;
    };
    const send = (path, fields) => budget.fetch(new Request(`https://eligibility.internal/${path}`, {
      method: 'POST',
      body: JSON.stringify({ day: new Date(now()).toISOString().slice(0, 10), deadline: now() + 5000, ...fields })
    }));
    let count = await readCount();
    if (count >= 16) return 'failed';
    const reserve = await send('reserve', {});
    if (!reserve.ok || (await reserve.json())?.reserved !== true || await readCount() !== count + 1) return 'failed';
    count++;
    for (let index = 0; count < 16 && index < 4; index++) {
      const leaseId = `00000000-0000-4000-8000-00000000000${index}`;
      const lease = await send('lease', { leaseId, count: 4 });
      if (!lease.ok) return 'failed';
      const body = await lease.json();
      const granted = Math.min(4, 16 - count);
      if (body?.reserved !== true || body.count !== granted || await readCount() !== count + granted) return 'failed';
      count += granted;
    }
    if (count !== 16) return 'failed';
    const denied = await send('reserve', {});
    return !denied.ok && await readCount() === 16 ? 'passed' : 'failed';
  } catch {
    return 'failed';
  }
}
