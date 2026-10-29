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

export function createRunController() {
  return async () => reply(503, { error: 'unavailable' });
}
