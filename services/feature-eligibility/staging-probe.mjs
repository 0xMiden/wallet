function reply(status, body) {
  return Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
}

export default {
  async fetch(request, env) {
    if (
      typeof env.PROBE_BEARER !== 'string' ||
      !env.PROBE_BEARER ||
      request.headers.get('Authorization') !== `Bearer ${env.PROBE_BEARER}`
    ) {
      return reply(403, { error: 'forbidden' });
    }

    const url = new URL(request.url);
    if (
      request.method !== 'GET' ||
      request.body !== null ||
      url.search ||
      !['/health', '/probe/caller', '/probe/colo'].includes(url.pathname)
    ) {
      return reply(400, { error: 'bad_request' });
    }
    if (url.pathname === '/health') return reply(200, { status: 'health_ok' });

    try {
      if (typeof env.PROBE_HASH_SECRET !== 'string' || !env.PROBE_HASH_SECRET) {
        return reply(503, { error: 'binding_unknown' });
      }
      const route = url.pathname === '/probe/caller' ? 'caller' : 'colo';
      const encoder = new TextEncoder();
      const secret = await crypto.subtle.importKey(
        'raw',
        encoder.encode(env.PROBE_HASH_SECRET),
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign']
      );
      const bytes = await crypto.subtle.sign('HMAC', secret, encoder.encode(`probe:${route}`));
      const key = [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, '0')).join('');
      const binding = route === 'caller' ? env.CALLER_PROBE : env.COLO_PROBE;
      const result = await binding.limit({ key });
      if (typeof result?.success !== 'boolean') return reply(503, { error: 'binding_unknown' });
      return result.success ? reply(200, { result: 'stub_allowed' }) : reply(429, { result: 'limited' });
    } catch {
      return reply(503, { error: 'binding_unknown' });
    }
  }
};
