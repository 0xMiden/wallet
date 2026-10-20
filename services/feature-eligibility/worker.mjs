const NETWORKS = new Set(['mainnet', 'testnet', 'devnet']);
const CONFIG_BASE = 'https://raw.githubusercontent.com/0xMiden/wallet-config/main';
const MAXMIND_BASE = 'https://geoip.maxmind.com/geoip/v2.1/city';
const POLICY_TTL = 60_000;
const DECISION_TTL = 300_000;
const FEATURES = ['wallet', 'earn', 'swap'];
const ALIASES = new Map([
  ['ny state', { country: 'US', region: 'NY' }],
  ['new york', { country: 'US', region: 'NY' }],
  ['uk', { country: 'GB' }],
  ['united kingdom', { country: 'GB' }],
  ['great britain', { country: 'GB' }]
]);

const record = value => typeof value === 'object' && value !== null && !Array.isArray(value);
const failure = (status = 503) => json({ error: 'eligibility_unavailable' }, status);
const dayOf = value => new Date(value).toISOString().slice(0, 10);

function json(body, status = 200, extraHeaders = {}) {
  return Response.json(body, {
    status,
    headers: { 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff', ...extraHeaders }
  });
}

function integer(value, minimum, maximum) {
  if (typeof value !== 'string' || !/^(0|[1-9]\d*)$/.test(value)) throw new Error('Invalid configuration');
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < minimum || result > maximum) throw new Error('Invalid configuration');
  return result;
}

function origins(env) {
  const values = JSON.parse(env.ALLOWED_ORIGINS ?? '[]');
  if (!Array.isArray(values) || values.some(value => typeof value !== 'string' || !value || value.includes('*'))) {
    throw new Error('Invalid configuration');
  }
  return new Set(values);
}

function callerIp(request) {
  // Same-zone Worker subrequests can modify x-real-ip, which changes CF-Connecting-IP.
  if (!record(request.cf) || typeof request.cf.colo !== 'string' || request.headers.has('CF-Worker')) return null;
  const ip = request.headers.get('CF-Connecting-IP') ?? '';
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) {
    return ip.split('.').every(part => String(Number(part)) === part && Number(part) <= 255) ? ip : null;
  }
  if (!ip.includes(':') || !/^[\da-f:.]+$/i.test(ip)) return null;
  try {
    return new URL(`http://[${ip}]/`).hostname.slice(1, -1);
  } catch {
    return null;
  }
}

function placeRule(phrase) {
  const normalized = phrase.trim().replace(/\s+/g, ' ').toLowerCase();
  if (!normalized.startsWith('block ')) throw new Error('Invalid policy');
  const name = normalized.slice(6);
  if (ALIASES.has(name)) return ALIASES.get(name);
  if (/^[a-z]{2}$/.test(name)) return { country: name.toUpperCase() };
  const parts = /^([a-z]{2})-([a-z\d]{1,3})$/.exec(name);
  if (!parts) throw new Error('Invalid policy');
  return { country: parts[1].toUpperCase(), region: parts[2].toUpperCase() };
}

function solverEnabled(value) {
  if (value === undefined) return false;
  if (!record(value)) throw new Error('Invalid policy');
  if (value.etaUrl === undefined) return false;
  if (typeof value.etaUrl !== 'string') throw new Error('Invalid policy');
  const url = new URL(value.etaUrl);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error('Invalid policy');
  return true;
}

function readPolicy(body, network) {
  if (!record(body) || body.network !== network || !Number.isSafeInteger(body.version) || body.version <= 0) {
    throw new Error('Invalid policy');
  }
  const features = body.features === undefined ? {} : body.features;
  if (!record(features) || (features.earn !== undefined && typeof features.earn !== 'boolean')) {
    throw new Error('Invalid policy');
  }
  const enabled = { wallet: true, earn: features.earn === true, swap: solverEnabled(body.swap) };
  if (!record(body.geo) || !record(body.geo.wallet)) throw new Error('Invalid policy');
  const rules = { wallet: [], earn: [], swap: [] };
  for (const feature of FEATURES) {
    const entries = body.geo?.[feature];
    if (entries === undefined) continue;
    if (!record(entries)) throw new Error('Invalid policy');
    for (const [phrase, answer] of Object.entries(entries)) {
      if (answer !== 'yes' && answer !== 'no') throw new Error('Invalid policy');
      if (answer === 'yes') rules[feature].push(placeRule(phrase));
    }
  }
  return { network, version: body.version, enabled, rules };
}

function readPlace(body) {
  if (!record(body) || !record(body.country) || typeof body.country.iso_code !== 'string' || !/^[a-z]{2}$/i.test(body.country.iso_code)) {
    throw new Error('Invalid lookup');
  }
  const subdivision = Array.isArray(body.subdivisions) ? body.subdivisions[0] : undefined;
  const region = record(subdivision) && typeof subdivision.iso_code === 'string' && /^[a-z\d]{1,3}$/i.test(subdivision.iso_code)
    ? subdivision.iso_code.toUpperCase()
    : undefined;
  return { country: body.country.iso_code.toUpperCase(), region };
}

function allowedAt(policy, place) {
  const allowed = Object.fromEntries(FEATURES.map(feature => [
    feature,
    policy.enabled[feature] && !policy.rules[feature].some(rule =>
      rule.country === place.country && (!rule.region || !place.region || rule.region === place.region)
    )
  ]));
  return allowed.wallet ? allowed : { wallet: false, earn: false, swap: false };
}

async function digest(secret, value) {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const bytes = await crypto.subtle.sign('HMAC', key, encoder.encode(value));
  return [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

export function createService({ fetchImpl = fetch, now = Date.now, timeoutMs = 5_000 } = {}) {
  function usableCache(cache, policy, identity) {
    return cache?.version === policy.version && cache.identity === identity && cache.expires > now() &&
      record(cache.allowed) && FEATURES.every(feature => typeof cache.allowed[feature] === 'boolean') &&
      (cache.allowed.wallet || (!cache.allowed.earn && !cache.allowed.swap));
  }

  async function fetchJson(url, init, maxBytes) {
    const controller = new AbortController();
    let reader;
    let timer;
    const deadline = new Promise((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new Error('Upstream unavailable'));
      }, timeoutMs);
    });
    try {
      return await Promise.race([deadline, (async () => {
        // Workers does not support redirect: 'error'; reject redirects before reading their body.
        const response = await fetchImpl(url, { ...init, redirect: 'manual', cache: 'no-store', signal: controller.signal });
        if (!response.ok || !response.body) throw new Error('Upstream unavailable');
        reader = response.body.getReader();
        const decoder = new TextDecoder();
        let length = 0;
        let text = '';
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          length += value.byteLength;
          if (length > maxBytes) throw new Error('Upstream unavailable');
          text += decoder.decode(value, { stream: true });
        }
        return JSON.parse(text + decoder.decode());
      })()]);
    } finally {
      clearTimeout(timer);
      controller.abort();
      if (reader) reader.cancel().catch(() => {});
    }
  }

  class EligibilityGuard {
    constructor(state, env) {
      this.storage = state.storage;
      this.env = env;
      this.policies = new Map();
      this.inflight = new Map();
    }

    async policy(network) {
      let entry = this.policies.get(network);
      if (!entry || entry.expires <= now()) {
        const pending = fetchJson(`${CONFIG_BASE}/${network}.json`, { headers: { Accept: 'application/json' } }, 262_144)
          .then(body => readPolicy(body, network));
        entry = { expires: now() + POLICY_TTL, pending };
        this.policies.set(network, entry);
        pending.catch(() => {
          if (this.policies.get(network) === entry) this.policies.delete(network);
        });
      }
      return entry.pending;
    }

    async caller(key) {
      const limit = integer(this.env.CALLER_REQUESTS_PER_MINUTE ?? '60', 1, 10_000);
      return this.storage.transaction(async transaction => {
        const current = await transaction.get(key) ?? { count: 0, window: now(), cache: {} };
        if (now() - current.window >= 60_000) {
          current.count = 0;
          current.window = now();
        }
        if (current.count >= limit) return null;
        current.count += 1;
        current.expires = now() + DECISION_TTL;
        await transaction.put(key, current);
        return current;
      });
    }

    async evaluate(ip, policy, callerKey, identity) {
      const latest = await this.storage.get(callerKey);
      const cached = latest?.cache[policy.network];
      if (usableCache(cached, policy, identity)) return cached.allowed;
      const limit = integer(this.env.MAXMIND_DAILY_QUERY_LIMIT, 0, 1_000_000);
      if (!this.env.MAXMIND_ACCOUNT_ID || !this.env.MAXMIND_LICENSE_KEY) throw new Error('Unavailable');
      const authorization = `Basic ${btoa(`${this.env.MAXMIND_ACCOUNT_ID}:${this.env.MAXMIND_LICENSE_KEY}`)}`;
      // Reservations count every attempted paid request, including failures, and survive eviction.
      const reserved = await this.storage.transaction(async transaction => {
        let budget = await transaction.get('budget');
        if (budget?.day !== dayOf(now())) budget = { day: dayOf(now()), count: 0 };
        if (budget.count >= limit) return false;
        budget.count += 1;
        await transaction.put('budget', budget);
        return true;
      });
      if (!reserved) throw new Error('Unavailable');
      const place = readPlace(await fetchJson(`${MAXMIND_BASE}/${encodeURIComponent(ip)}`, {
        headers: { Accept: 'application/json', Authorization: authorization }
      }, 65_536));
      const allowed = allowedAt(policy, place);
      await this.storage.transaction(async transaction => {
        const current = await transaction.get(callerKey);
        current.cache[policy.network] = { version: policy.version, identity, allowed, expires: now() + DECISION_TTL };
        current.expires = now() + DECISION_TTL;
        await transaction.put(callerKey, current);
      });
      return allowed;
    }

    async fetch(request) {
      try {
        const { ip, network } = await request.json();
        if (request.method !== 'POST' || !NETWORKS.has(network) || typeof ip !== 'string' || ip.length > 45) return failure();
        if (typeof this.env.CALLER_HASH_SECRET !== 'string' || this.env.CALLER_HASH_SECRET.length < 32) return failure();
        const callerKey = `caller:${await digest(this.env.CALLER_HASH_SECRET, `${dayOf(now())}:${ip}`)}`;
        const caller = await this.caller(callerKey);
        if (!caller) return json({ error: 'eligibility_unavailable' }, 429, { 'Retry-After': '60' });
        if (await this.storage.getAlarm() === null) await this.storage.setAlarm(now() + DECISION_TTL);
        const policy = await this.policy(network);
        const identity = await digest(this.env.CALLER_HASH_SECRET, JSON.stringify(policy));
        const needsLookup = FEATURES.some(feature => policy.enabled[feature] && policy.rules[feature].length > 0);
        let allowed = policy.enabled;
        if (needsLookup) {
          const cached = caller.cache[network];
          if (usableCache(cached, policy, identity)) {
            allowed = cached.allowed;
          } else {
            const key = `${callerKey}:${network}:${identity}`;
            let pending = this.inflight.get(key);
            if (!pending) {
              pending = this.evaluate(ip, policy, callerKey, identity);
              this.inflight.set(key, pending);
            }
            try {
              allowed = await pending;
            } finally {
              if (this.inflight.get(key) === pending) this.inflight.delete(key);
            }
          }
        }
        return json({ network, version: policy.version, allowed });
      } catch {
        return failure();
      }
    }

    async alarm() {
      const delay = await this.storage.transaction(async transaction => {
        const cursor = await transaction.get('cleanup-cursor') ?? '';
        const entries = await transaction.list({ prefix: 'caller:', startAfter: cursor, limit: 128 });
        const expired = [...entries].filter(([, value]) => value.expires <= now()).map(([key]) => key);
        if (expired.length > 0) await transaction.delete(expired);
        if (entries.size === 128) {
          await transaction.put('cleanup-cursor', [...entries.keys()].at(-1));
          return 1_000;
        }
        await transaction.delete('cleanup-cursor');
        return entries.size > expired.length || cursor ? DECISION_TTL : null;
      });
      if (delay !== null) await this.storage.setAlarm(now() + delay);
    }
  }

  async function handle(request, env) {
    let finish = response => response;
    try {
      const url = new URL(request.url);
      const allowedOrigins = origins(env);
      const origin = request.headers.get('Origin');
      if (origin && !allowedOrigins.has(origin)) return failure(403);
      const headers = { Vary: 'Origin' };
      if (origin) headers['Access-Control-Allow-Origin'] = origin;
      finish = response => new Response(response.body, {
        status: response.status,
        headers: { ...Object.fromEntries(response.headers), ...headers }
      });
      if (url.pathname === '/healthz' && request.method === 'GET') {
        const ready = env.ELIGIBILITY_GUARD && env.MAXMIND_ACCOUNT_ID && env.MAXMIND_LICENSE_KEY &&
          typeof env.CALLER_HASH_SECRET === 'string' && env.CALLER_HASH_SECRET.length >= 32 &&
          integer(env.MAXMIND_DAILY_QUERY_LIMIT, 0, 1_000_000) > 0;
        return finish(ready ? json({ ready: true, revision: env.DEPLOYMENT_REVISION ?? 'unknown' }) : failure());
      }
      if (url.pathname !== '/v1/eligibility') return finish(failure(404));
      const network = url.searchParams.get('network');
      if (!NETWORKS.has(network) || [...url.searchParams].length !== 1) return finish(failure(400));
      if (request.method === 'OPTIONS') {
        if (request.headers.get('Access-Control-Request-Method') !== 'GET' || request.headers.has('Access-Control-Request-Headers')) {
          return finish(failure(403));
        }
        return finish(new Response(null, {
          status: 204,
          headers: { 'Cache-Control': 'private, no-store', 'Access-Control-Allow-Methods': 'GET' }
        }));
      }
      if (request.method !== 'GET') return finish(failure(405));
      const ip = callerIp(request);
      if (!ip) return finish(failure(400));
      const guard = env.ELIGIBILITY_GUARD.get(env.ELIGIBILITY_GUARD.idFromName('global-v1'));
      const response = await guard.fetch(new Request('https://eligibility.internal/', {
        method: 'POST',
        body: JSON.stringify({ ip, network })
      }));
      return finish(response);
    } catch {
      return finish(failure());
    }
  }

  return { fetch: handle, EligibilityGuard };
}

const service = createService();
export const EligibilityGuard = service.EligibilityGuard;
export default { fetch: service.fetch };
